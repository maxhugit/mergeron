// Cwd is the disposable data directory: migrations and logs stay isolated.
const path = require('node:path');
const repository = path.resolve(__dirname, '../..');
require(path.join(repository, 'dist/main.js'));
