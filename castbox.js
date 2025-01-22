const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Function to sanitize file names
const sanitizeFileName = (name) => {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
};

// User agents for Bing and Google bots
const userAgents = [
  'Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
];

(async () => {
  // Launch the browser
  const browser = await chromium.launch();

  // Read all text files in the current directory
  const textFiles = fs.readdirSync(__dirname).filter(file => file.endsWith('.txt'));

  for (const textFile of textFiles) {
    const linksFilePath = path.join(__dirname, textFile);
    const urls = fs.readFileSync(linksFilePath, 'utf8').split('\n').filter(Boolean);

    if (urls.length === 0) {
      console.error(`No URLs found in ${textFile}.`);
      continue; // Skip to the next file
    }

    // Create a folder for the current text file
    const outputDir = path.join(__dirname, sanitizeFileName(textFile.replace('.txt', '')));
    fs.mkdirSync(outputDir, { recursive: true });

    for (const [index, url] of urls.entries()) {
      const userAgent = userAgents[index % userAgents.length]; // Alternate user agents
      const context = await browser.newContext({ userAgent });
      const page = await context.newPage();

      // Navigate to the specified URL and wait for redirections
      let finalUrl;
      try {
        const response = await page.goto(url, {
          waitUntil: 'networkidle',
        });
        finalUrl = response.url(); // Get the final URL after redirection
      } catch (error) {
        console.error(`Error navigating to ${url}:`, error);
        await context.close();
        continue; // Skip to the next URL
      }

      // Extract the <h1> tag text for the filename
      const h1Text = await page.$eval('h1', h1 => h1.innerText);
      const sanitizedFileName = sanitizeFileName(h1Text);

      // Counter for filename generation
      let fileCounter = 1;

      // Listen for responses
      page.on('response', async (response) => {
        const contentType = response.headers()['content-type'];

        // Check if the response is JSON
        if (response.ok() && contentType && contentType.includes('application/json')) {
          const json = await response.json();
          // Create a filename based on the sanitized <h1> text and counter
          const filename = path.join(outputDir, `${sanitizedFileName}_${fileCounter}.json`);
          fs.writeFileSync(filename, JSON.stringify(json, null, 2), 'utf8');
          console.log(`Saved: ${filename}`);
          fileCounter++; // Increment the counter for the next file name
        }
      });

      // Intercept network requests to allow them to continue
      await page.route('**/*', (route) => route.continue());

      // Scroll to the bottom of the page with randomized wait times
      let previousHeight;
      while (true) {
        previousHeight = await page.evaluate('document.body.scrollHeight');
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        const waitTime = Math.floor(Math.random() * 3000) + 2000; // Random wait between 2-5 seconds
        await page.waitForTimeout(waitTime); // Wait for new content to load
        const newHeight = await page.evaluate('document.body.scrollHeight');
        if (newHeight === previousHeight) break; // Exit if no new content
      }

      // Close the context for the current URL
      await context.close();

      // Process JSON files to create output.csv
      const jsonFiles = fs.readdirSync(outputDir).filter(file => file.endsWith('.json'));
      const records = [];

      jsonFiles.forEach(file => {
        const data = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8'));
        if (data.data && data.data.episode_list) {
          data.data.episode_list.forEach(episode => {
            records.push({
              eid: episode.eid,
              title: episode.title,
              url: episode.urls[0]
            });
          });
        }
      });

      // Write to output.csv
      const csvPath = path.join(outputDir, `${sanitizedFileName}.csv`);
      const csvHeader = 'EID,Title,URL\n';
      const csvRows = records.map(record => `${record.eid},"${record.title}","${record.url}"`).join('\n');
      fs.writeFileSync(csvPath, csvHeader + csvRows, 'utf8');
      console.log(`Generated ${csvPath} successfully.`);

      // Create playlist.m3u
      const m3uPath = path.join(outputDir, `${sanitizedFileName}.m3u`);
      const m3uContent = [
        '#EXTM3U', // Add the #EXTM3U header
        ...records.map(record => `#EXTINF:-1,${record.title}\n${record.url}`) // Remove quotes from URLs
      ].join('\n');

      fs.writeFileSync(m3uPath, m3uContent, 'utf8');
      console.log(`Generated ${m3uPath} successfully.`);

      // Cleanup: Remove JSON files after processing
      jsonFiles.forEach(file => {
        fs.unlinkSync(path.join(outputDir, file));
        console.log(`Deleted: ${file}`);
      });
    }
  }

  // Close the browser after processing all URLs
  await browser.close();
})();
