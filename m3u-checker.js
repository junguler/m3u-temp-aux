// m3u-checker.js
//
// Recursively scans the input folder for .m3u / .m3u8 files and writes
// cleaned playlists to the output folder, preserving sub-folder structure.
//
// Usage:
//   node m3u-checker.js
//   node m3u-checker.js input_folder/ output_folder/
//   node m3u-checker.js input_folder/ output_folder/ --quiet
//
// Environment variables:
//   CONCURRENCY=100
//   LINK_TIMEOUT=8000
//   MAX_REDIRECTS=3
//   PROGRESS_INTERVAL=30000

const fs = require('fs/promises');
const path = require('path');

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const concurrencyLimit = Math.max(1, toNumber(process.env.CONCURRENCY, 50));
const linkTimeout = Math.max(1000, toNumber(process.env.LINK_TIMEOUT, 8000));
const maxRedirects = Math.max(0, toNumber(process.env.MAX_REDIRECTS, 3));
const progressInterval = Math.max(0, toNumber(process.env.PROGRESS_INTERVAL, 60000));

// Hard runtime limit for GitHub Actions (6h max).
const MAX_RUNTIME_MS = (5 * 60 + 45) * 60 * 1000; // 5h 45m
const USER_AGENT = 'm3u-checker/1.0';

let quietMode = false;
let timeUp = false;

const stats = {
  startTime: Date.now(),
  totalFiles: 0,
  filesParsed: 0,
  filesDone: 0,
  totalLinks: 0,
  checked: 0,
  alive: 0,
  timedOut: 0,
  invalid: 0,
  httpError: 0,
  inFlight: 0,
  activeFiles: new Map(),
  fileEvents: [],
  lastEventIndex: 0,
};

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

function truncateMiddle(text, maxLength) {
  const s = String(text);

  if (s.length <= maxLength) return s;
  if (maxLength <= 1) return '…';

  const leftLength = Math.ceil((maxLength - 1) / 2);
  const rightLength = maxLength - 1 - leftLength;

  return `${s.slice(0, leftLength)}…${s.slice(s.length - rightLength)}`;
}

function renderTable({ headers = [], rows = [], aligns = [] } = {}) {
  let safeRows = rows.map((row) => (Array.isArray(row) ? row : [row]));
  const colCount = headers.length || safeRows[0]?.length || 0;

  if (!colCount) return;

  safeRows = safeRows.map((row) => {
    const out = [];

    for (let i = 0; i < colCount; i += 1) {
      const value = row[i];

      out.push(
        value === undefined || value === null
          ? ''
          : String(value)
              .replace(/\r?\n/g, ' ')
              .replace(/\s+/g, ' ')
              .trim(),
      );
    }

    return out;
  });

  if (!safeRows.length) {
    safeRows = [headers.map(() => '')];
  }

  const widths = [];

  for (let i = 0; i < colCount; i += 1) {
    widths.push(
      Math.max(
        String(headers[i] ?? '').length,
        ...safeRows.map((row) => row[i].length),
        3,
      ),
    );
  }

  const terminalWidth = Math.max(
    80,
    Math.min(Number(process.stdout.columns) || 150, 200),
  );

  const estimatedWidth =
    widths.reduce((sum, w) => sum + w, 0) + colCount * 3 + 1;

  if (estimatedWidth > terminalWidth) {
    let excess = estimatedWidth - terminalWidth;

    const order = widths
      .map((width, index) => ({ width, index }))
      .sort((a, b) => b.width - a.width);

    for (const { index } of order) {
      if (excess <= 0) break;

      const minWidth = 6;
      const reducible = widths[index] - minWidth;

      if (reducible > 0) {
        const reduction = Math.min(reducible, excess);
        widths[index] -= reduction;
        excess -= reduction;
      }
    }
  }

  const truncate = (text, width) => {
    const s = String(text);

    if (s.length <= width) return s;
    if (width <= 1) return s.slice(0, width);

    return `${s.slice(0, width - 1)}…`;
  };

  const pad = (text, width, align) => {
    const s = truncate(text, width);
    return align === 'right' ? s.padStart(width) : s.padEnd(width);
  };

  const horizontal = (left, middle, right) =>
    `${left}─${widths.map((w) => '─'.repeat(w)).join(`─${middle}─`)}─${right}`;

  const renderRow = (row, isHeader = false) =>
    `│ ${row
      .map((cell, i) => {
        const aligned = pad(
          cell,
          widths[i],
          isHeader ? 'left' : aligns[i] || 'left',
        );

        return aligned;
      })
      .join(' │ ')} │`;

  const lines = [
    horizontal('┌', '┬', '┐'),
    renderRow(headers, true),
    horizontal('├', '┼', '┤'),
    ...safeRows.map((row) => renderRow(row)),
    horizontal('└', '┴', '┘'),
  ];

  console.log(lines.join('\n'));
}

function addFileEvent(file, checked, total, alive, result) {
  stats.fileEvents.push({
    file,
    checked,
    total,
    alive,
    result,
  });
}

function printNewFileEvents() {
  const events = stats.fileEvents.slice(stats.lastEventIndex);

  if (!events.length) return;

  stats.lastEventIndex = stats.fileEvents.length;

  const rows = events.map((event) => [
    truncateMiddle(event.file, 60),
    `${event.checked}/${event.total}`,
    String(event.alive),
    event.result,
  ]);

  renderTable({
    headers: ['Playlist result', 'Checked', 'Alive', 'Result'],
    rows,
    aligns: ['left', 'right', 'right', 'left'],
  });
}

function printStartup(inputDir, outputDir, fileCount) {
  renderTable({
    headers: [
      'Input',
      'Output',
      'Playlists',
      'Concurrency',
      'Timeout',
      'Progress',
      'Max runtime',
      'Mode',
    ],
    rows: [
      [
        inputDir,
        outputDir,
        String(fileCount),
        String(concurrencyLimit),
        `${linkTimeout}ms`,
        progressInterval > 0 ? `${progressInterval}ms` : 'off',
        formatDuration(MAX_RUNTIME_MS),
        quietMode ? 'quiet' : 'normal',
      ],
    ],
  });
}

function printProgress(final = false) {
  const elapsedMs = Date.now() - stats.startTime;
  const elapsedSeconds = elapsedMs / 1000;

  const percent =
    stats.totalLinks > 0
      ? ((stats.checked / stats.totalLinks) * 100).toFixed(1)
      : '0.0';

  const rate = elapsedSeconds > 0 ? stats.checked / elapsedSeconds : 0;

  let eta = '-';

  if (!final && stats.filesParsed >= stats.totalFiles && rate > 0) {
    const remaining = stats.totalLinks - stats.checked;
    eta = remaining > 0 ? formatDuration((remaining / rate) * 1000) : '0s';
  }

  renderTable({
    headers: [
      'Report',
      'Elapsed',
      'Files',
      'Links',
      'In flight',
      'Alive',
      'Timed out',
      'Invalid',
      'HTTP',
      'Speed',
      'ETA',
    ],
    rows: [
      [
        final ? 'FINAL' : 'PROGRESS',
        formatDuration(elapsedMs),
        `${stats.filesDone}/${stats.totalFiles} done, ${stats.filesParsed}/${stats.totalFiles} read`,
        `${stats.checked}/${stats.totalLinks} (${percent}%)`,
        String(stats.inFlight),
        String(stats.alive),
        String(stats.timedOut),
        String(stats.invalid),
        String(stats.httpError),
        `${rate.toFixed(1)}/s`,
        final ? '-' : eta,
      ],
    ],
  });

  if (!final && stats.activeFiles.size > 0) {
    const active = [...stats.activeFiles.entries()]
      .sort(
        (a, b) =>
          b[1].total - b[1].checked - (a[1].total - a[1].checked),
      )
      .slice(0, 5);

    const rows = active.map(([name, info]) => [
      truncateMiddle(name, 60),
      `${info.checked}/${info.total}`,
      String(info.alive),
      String(Math.max(0, info.total - info.checked)),
    ]);

    if (stats.activeFiles.size > active.length) {
      rows.push([
        `… and ${stats.activeFiles.size - active.length} more in progress`,
        '',
        '',
        '',
      ]);
    }

    renderTable({
      headers: ['Active playlist', 'Checked', 'Alive', 'Remaining'],
      rows,
      aligns: ['left', 'right', 'right', 'right'],
    });
  }

  printNewFileEvents();
}

function printTimeLimitNotice() {
  renderTable({
    headers: ['Notice'],
    rows: [
      [
        'Runtime limit reached. New link checks were stopped. Fully checked playlists were removed; incomplete playlists remain in input.',
      ],
    ],
  });
}

function recordResult(status, fileName) {
  stats.checked += 1;

  const fileInfo = stats.activeFiles.get(fileName);

  if (fileInfo) {
    fileInfo.checked += 1;
  }

  if (typeof status === 'number' && status >= 200 && status < 300) {
    stats.alive += 1;

    if (fileInfo) {
      fileInfo.alive += 1;
    }
  } else if (status === 'timedout') {
    stats.timedOut += 1;
  } else if (status === 'invalid') {
    stats.invalid += 1;
  } else {
    stats.httpError += 1;
  }
}

function createLimiter(limit) {
  const queue = [];
  let active = 0;

  function runNext() {
    while (active < limit && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();

      active += 1;

      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          runNext();
        });
    }
  }

  return function limitTask(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
  };
}

function parseM3UContent(m3uContent) {
  const originalLines = m3uContent.split(/\r?\n/);
  const linksToProcess = [];

  let currentTitle = '';
  let currentTitleLineIndex = -1;

  for (let i = 0; i < originalLines.length; i += 1) {
    const line = originalLines[i].trim();

    if (line.startsWith('#EXTINF')) {
      currentTitle = line;
      currentTitleLineIndex = i;
      continue;
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
      linksToProcess.push({
        title: currentTitle,
        url: line,
        originalIndex: i,
        originalTitleLineIndex: currentTitleLineIndex,
      });

      currentTitle = '';
      currentTitleLineIndex = -1;
    }
  }

  return linksToProcess;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, linkTimeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestUrl(url) {
  let response = await fetchWithTimeout(url, {
    method: 'HEAD',
  });

  if (response.status === 405 || response.status === 501) {
    response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
      },
    });

    try {
      await response.body?.cancel();
    } catch {
      // Ignore body cancellation errors.
    }
  }

  return response;
}

async function checkSingleLink(item, fileName, quiet = false, redirectCount = 0) {
  let response;

  try {
    response = await requestUrl(item.url);

    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has('location');

    if (isRedirect && redirectCount < maxRedirects) {
      const redirectUrl = response.headers.get('location');
      const absoluteRedirectUrl = new URL(redirectUrl, item.url).href;

      return checkSingleLink(
        {
          ...item,
          url: absoluteRedirectUrl,
        },
        fileName,
        quiet,
        redirectCount + 1,
      );
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        url: item.url,
        status: response.status,
        finalUrl: item.url,
      };
    }

    return {
      url: item.url,
      status: response.status,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return {
        url: item.url,
        status: 'timedout',
      };
    }

    return {
      url: item.url,
      status: 'invalid',
    };
  } finally {
    if (response?.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore errors if the body was already consumed or canceled.
      }
    }
  }
}

async function processLinks(linksToProcess, fileName, quiet, limiter) {
  const validLinks = new Map();
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (timeUp) return;

      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= linksToProcess.length) return;

      const item = linksToProcess[currentIndex];

      const result = await limiter(async () => {
        if (timeUp) return null;

        stats.inFlight += 1;

        try {
          return await checkSingleLink(item, fileName, quiet);
        } finally {
          stats.inFlight -= 1;
        }
      });

      if (result === null) {
        continue;
      }

      recordResult(result.status, fileName);

      if (
        result &&
        typeof result.status === 'number' &&
        result.status >= 200 &&
        result.status < 300
      ) {
        validLinks.set(item.originalIndex, {
          titleLine: item.title,
          urlLine: result.finalUrl || item.url,
        });
      }
    }
  }

  const workerCount = Math.min(concurrencyLimit, linksToProcess.length);

  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return validLinks;
}

function findNextUrlIndex(lines, titleIndex) {
  for (let i = titleIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF')) {
      return -1;
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
      return i;
    }
  }

  return -1;
}

function generateOutputM3U(originalM3uContent, validLinks) {
  const originalLines = originalM3uContent.split(/\r?\n/);
  const outputLines = ['#EXTM3U'];

  for (let i = 0; i < originalLines.length; i += 1) {
    const rawLine = originalLines[i];
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    if (line.startsWith('#EXTM3U')) {
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      const urlIndex = findNextUrlIndex(originalLines, i);

      if (urlIndex !== -1 && validLinks.has(urlIndex)) {
        const { titleLine, urlLine } = validLinks.get(urlIndex);

        outputLines.push(titleLine);

        for (let j = i + 1; j < urlIndex; j += 1) {
          const intermediateLine = originalLines[j].trim();

          if (
            intermediateLine.length > 0 &&
            !intermediateLine.startsWith('http://') &&
            !intermediateLine.startsWith('https://') &&
            !intermediateLine.startsWith('#EXTINF')
          ) {
            outputLines.push(intermediateLine);
          }
        }

        outputLines.push(urlLine);

        i = urlIndex;
      } else if (urlIndex !== -1) {
        i = urlIndex;
      }

      continue;
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
      if (validLinks.has(i)) {
        const { urlLine } = validLinks.get(i);
        outputLines.push(urlLine);
      }

      continue;
    }

    outputLines.push(line);
  }

  return `${outputLines.join('\n')}\n`;
}

async function processFile(inputDir, outputDir, fileName, quiet, limiter) {
  if (timeUp) {
    return;
  }

  const fullPath = path.join(inputDir, fileName);
  const originalM3uContent = await fs.readFile(fullPath, 'utf8');
  const linksToProcess = parseM3UContent(originalM3uContent);

  stats.filesParsed += 1;
  stats.totalLinks += linksToProcess.length;

  stats.activeFiles.set(fileName, {
    total: linksToProcess.length,
    checked: 0,
    alive: 0,
  });

  async function removeFromInput() {
    try {
      await fs.unlink(fullPath);
    } catch {
      // If removal fails, continue silently.
    }
  }

  if (linksToProcess.length === 0) {
    const outputM3uContent = generateOutputM3U(originalM3uContent, new Map());

    let result = 'removed (empty)';

    if (outputM3uContent.trim() !== '#EXTM3U') {
      const outputPath = path.join(outputDir, fileName);

      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, outputM3uContent, 'utf8');

      result = 'saved metadata';
    }

    addFileEvent(fileName, 0, 0, 0, result);
    await removeFromInput();
    return;
  }

  const validLinks = await processLinks(
    linksToProcess,
    fileName,
    quiet,
    limiter,
  );

  const fileInfo = stats.activeFiles.get(fileName);
  const fullyChecked = Boolean(fileInfo && fileInfo.checked === fileInfo.total);

  if (timeUp && !fullyChecked) {
    addFileEvent(
      fileName,
      fileInfo ? fileInfo.checked : 0,
      linksToProcess.length,
      fileInfo ? fileInfo.alive : 0,
      'incomplete, kept',
    );

    return;
  }

  const validStreamCount = validLinks.size;

  if (validStreamCount === 0) {
    addFileEvent(
      fileName,
      linksToProcess.length,
      linksToProcess.length,
      0,
      'removed (no alive streams)',
    );

    await removeFromInput();
    return;
  }

  const outputM3UContent = generateOutputM3U(originalM3uContent, validLinks);

  if (outputM3UContent.trim() === '#EXTM3U') {
    addFileEvent(
      fileName,
      linksToProcess.length,
      linksToProcess.length,
      validStreamCount,
      'removed (empty output)',
    );

    await removeFromInput();
    return;
  }

  const outputPath = path.join(outputDir, fileName);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, outputM3UContent, 'utf8');

  addFileEvent(
    fileName,
    linksToProcess.length,
    linksToProcess.length,
    validStreamCount,
    'saved',
  );

  await removeFromInput();
}

async function collectM3UFiles(rootDir, skipDirs = []) {
  const results = [];
  const skip = new Set(skipDirs.map((dir) => path.resolve(dir)));

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          skip.has(path.resolve(fullPath))
        ) {
          continue;
        }

        await walk(fullPath);
      } else if (entry.isFile() && /\.m3u8?$/i.test(entry.name)) {
        results.push(
          path.relative(rootDir, fullPath).split(path.sep).join('/'),
        );
      }
    }
  }

  await walk(rootDir);
  return results;
}

async function main(inputDir, outputDir, quiet = false) {
  quietMode = quiet;

  await fs.mkdir(outputDir, { recursive: true });

  const m3uFiles = await collectM3UFiles(inputDir, [outputDir]);

  if (m3uFiles.length === 0) {
    renderTable({
      headers: ['Result'],
      rows: [
        [
          `No .m3u or .m3u8 files found in "${inputDir}" (searched recursively).`,
        ],
      ],
    });

    return;
  }

  stats.totalFiles = m3uFiles.length;
  stats.startTime = Date.now();

  printStartup(inputDir, outputDir, m3uFiles.length);

  const progressTimer =
    progressInterval > 0
      ? setInterval(() => {
          printProgress(false);
        }, progressInterval)
      : null;

  const timeUpTimer = setTimeout(() => {
    timeUp = true;
    printTimeLimitNotice();
    printProgress(false);
  }, MAX_RUNTIME_MS);

  const limiter = createLimiter(concurrencyLimit);

  try {
    await Promise.all(
      m3uFiles.map(async (fileName) => {
        try {
          await processFile(inputDir, outputDir, fileName, quiet, limiter);
        } catch (error) {
          addFileEvent(fileName, 0, 0, 0, `error: ${error.message}`);
        } finally {
          stats.filesDone += 1;
          stats.activeFiles.delete(fileName);
        }
      }),
    );
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
    }

    clearTimeout(timeUpTimer);
  }

  printProgress(true);

  if (timeUp) {
    renderTable({
      headers: ['Next run'],
      rows: [
        ['Remaining unchecked playlists are still in the input folder.'],
      ],
    });
  } else {
    renderTable({
      headers: ['Status'],
      rows: [['All M3U files processed.']],
    });
  }
}

let quiet = false;
const filteredArgs = [];

for (const arg of process.argv.slice(2)) {
  if (arg === '--quiet') {
    quiet = true;
  } else {
    filteredArgs.push(arg);
  }
}

const inputDirectory = filteredArgs[0] || 'm3u-files';
const outputDirectory = filteredArgs[1] || 'm3u-checked';

main(inputDirectory, outputDirectory, quiet).catch((error) => {
  renderTable({
    headers: ['Error'],
    rows: [[error.message]],
  });

  process.exitCode = 1;
});