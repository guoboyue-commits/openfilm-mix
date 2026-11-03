const { execFile } = require('child_process');
execFile('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['https://github.com/new?name=openfilm-mix'], { detached: true }, (e) => { if (e) console.log('ERR', e.message); });
console.log('opened');
