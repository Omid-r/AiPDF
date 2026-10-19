const path = require('node:path');
function under(file, root) {
  const rel = path.relative(root, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
function requestAllowed(req, port) {
  const authority = `127.0.0.1:${port}`;
  if (req.headers.host !== authority) return false;
  if (req.headers.origin && req.headers.origin !== `http://${authority}`) return false;
  return req.headers['sec-fetch-site'] !== 'cross-site';
}
module.exports = { under, requestAllowed };
