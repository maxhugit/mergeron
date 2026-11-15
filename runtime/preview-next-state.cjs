'use strict';
const {
  openSync,
  readFileSync,
  fstatSync,
  closeSync,
  constants,
} = require('node:fs');
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function readJson(file) {
  let fd;
  try {
    if (!file) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) return null;
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function generation(file) {
  const value = readJson(file);
  return value?.schemaVersion === 1 && UUID.test(value.generation)
    ? value.generation
    : null;
}
module.exports = { readJson, generation, UUID };
