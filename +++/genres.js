const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Read URLs from genres.txt
const linksFilePath = path.join(__dirname, 'genres.txt');
const urls = fs.readFileSync(linksFilePath, 'utf8').split('\n').filter(Boolean);

if (urls.length === 0) {
  console.error('No URLs found in genres.txt.');
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
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to the specified URL and wait for redirections
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
    } catch (error) {
      console.error(`Error navigating to ${url}:`, error);
      await context.close();
      continue; // Skip to the next URL
    }

    // Scroll to the bottom of the page with randomized wait times
    let previousHeight;
    const linksSet = new Set(); // Use a Set to store unique links
    let noNewContentCount = 0; // Counter for no new content
    const maxNoNewContent = 5; // Maximum iterations without new content

    while (noNewContentCount < maxNoNewContent) {
      previousHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      const waitTime = Math.floor(Math.random() * 3000) + 2000; // Random wait between 2-5 seconds
      await page.waitForTimeout(waitTime); // Wait for new content to load
      const newHeight = await page.evaluate('document.body.scrollHeight');

      // Extract links containing the word "channel"
      const links = await page.$$eval('a[href*="channel"]', anchors => 
        anchors.map(anchor => anchor.href)
      );

      // Add links to the Set to avoid duplicates
      links.forEach(link => linksSet.add(link));

      // Check if new content was loaded
      if (newHeight === previousHeight) {
        noNewContentCount++; // Increment the counter if no new content
      } else {
        noNewContentCount = 0; // Reset the counter if new content is found
      }
    }

    // Convert Set to Array and sort links
    const uniqueLinks = Array.from(linksSet).sort();

    // Get the last part of the URL for the filename
    const lastPart = url.split('/').pop();
    const sanitizedFileName = sanitizeFileName(lastPart) + '.txt';
    const filePath = path.join(__dirname, sanitizedFileName);

    // Write the unique links to the text file
    fs.writeFileSync(filePath, uniqueLinks.join('\n'), 'utf8');
    console.log(`Saved links to: ${filePath}`);

    // Close the context for the current URL
    await context.close();
  }

  // Close the browser after processing all URLs
  await browser.close();
})();
