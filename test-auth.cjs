const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER_LOG:', msg.text()));
  
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 15000 });
  
  const result = await page.evaluate(async () => {
    try {
      const email = 'divyesh.boston@gmail.com';
      const password = '22112004@Djvp';
      
      // We will access the db from window
      // Let's import it dynamically if we can, but since this is a Vite app, 
      // maybe we can just trigger a registration.
      // We can create a user in Dexie directly.
      const request = indexedDB.open('RedRoofIntelligence');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = () => reject('failed to open db');
      });
      
      // Let's see if the user exists
      const users = await new Promise((resolve) => {
        const tx = db.transaction('User', 'readonly');
        const store = tx.objectStore('User');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
      });
      
      let user = users.find(u => u.email === email);
      
      return { 
        status: 'success', 
        userCount: users.length,
        userExists: !!user,
        user: user ? { id: user.id, email: user.email, hasHash: !!user.password_hash } : null
      };
    } catch (e) {
      return { error: e.message };
    }
  });
  
  console.log('RESULT:', JSON.stringify(result, null, 2));
  
  await browser.close();
})();
