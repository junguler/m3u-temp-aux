const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Read URLs from links.txt
const linksFilePath = path.join(__dirname, 'links.txt');
const urls = fs.readFileSync(linksFilePath, 'utf8').split('\n').filter(Boolean);

if (urls.length === 0) {
  console.error('No URLs found in links.txt.');
  process.exit(1); // Exit the script with an error code
}

// Function to sanitize file names
const sanitizeFileName = (name) => {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
};

(async () => {
  // Launch the browser
  const browser = await chromium.launch();
  
  for (const url of urls) {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });
    const page = await context.newPage();

    // Extract the channel name from the URL
    const channelName = url.split('/').pop().split('-id')[0];
    const sanitizedChannelName = sanitizeFileName(channelName);

    // Counter for filename generation
    let fileCounter = 1;

    // Listen for responses
    page.on('response', async (response) => {
      const contentType = response.headers()['content-type'];

      // Check if the response is JSON
      if (response.ok() && contentType && contentType.includes('application/json')) {
        const json = await response.json();
        // Create a filename based on the sanitized channel name and counter
        const filename = path.join(__dirname, `${sanitizedChannelName}_${fileCounter}.json`);
        fs.writeFileSync(filename, JSON.stringify(json, null, 2), 'utf8');
        console.log(`Saved: ${filename}`);
        fileCounter++; // Increment the counter for the next file name
      }
    });

    // Intercept network requests to allow them to continue
    await page.route('**/*', (route) => route.continue());

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

    // Scroll to the bottom of the page until no new content is loaded
    let previousHeight;
    while (true) {
      previousHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await page.waitForTimeout(2000); // Wait for new content to load
      const newHeight = await page.evaluate('document.body.scrollHeight');
      if (newHeight === previousHeight) break; // Exit if no new content
    }

    // Close the context for the current URL
    await context.close();

    // Process JSON files to create output.csv
    const jsonFiles = fs.readdirSync(__dirname).filter(file => file.endsWith('.json'));
    const records = [];

    jsonFiles.forEach(file => {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
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
    const csvPath = path.join(__dirname, `${sanitizedChannelName}.csv`);
    const csvHeader = 'EID,Title,URL\n';
    const csvRows = records.map(record => `${record.eid},"${record.title}","${record.url}"`).join('\n');
    fs.writeFileSync(csvPath, csvHeader + csvRows, 'utf8');
    console.log(`Generated ${csvPath} successfully.`);

    // Create playlist.m3u
    const m3uPath = path.join(__dirname, `${sanitizedChannelName}.m3u`);
    const m3uContent = [
      '#EXTM3U', // Add the #EXTM3U header
      ...records.map(record => `#EXTINF:-1,${record.title}\n${record.url}`) // Remove quotes from URLs
    ].join('\n');

    fs.writeFileSync(m3uPath, m3uContent, 'utf8');
    console.log(`Generated ${m3uPath} successfully.`);

    // Cleanup: Remove JSON files after processing
    jsonFiles.forEach(file => {
      fs.unlinkSync(path.join(__dirname, file));
      console.log(`Deleted: ${file}`);
    });
  }

  // Close the browser after processing all URLs
  await browser.close();
})();
