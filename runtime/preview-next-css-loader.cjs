'use strict';
const { generation } = require('./preview-next-state.cjs');
module.exports = function (source) {
  const { receiptPath } = this.getOptions();
  this.addDependency(receiptPath);
  const current = generation(receiptPath);
  return current
    ? source + `\n:root{--mergeron-preview-generation:"${current}"}\n`
    : source;
};
