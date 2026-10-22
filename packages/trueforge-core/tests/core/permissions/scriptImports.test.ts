import { scriptLoadsOnlyStandardCode } from '../../../src/core/permissions/scriptImports';

describe('scriptLoadsOnlyStandardCode for python', () => {
  test.each([
    ['', true],
    ['import json', true],
    ['import os.path, sys', true],
    ['from collections import deque', true],
    ['def f():\n    import math\n    return math.pi\n', true],
  ])('%j is standard', (source, expected) => {
    expect(scriptLoadsOnlyStandardCode({ runtime: 'python', source })).toBe(expected);
  });

  test.each([
    ['import helper'],
    ['from helper import f'],
    ['from . import sibling'],
    ['from .sibling import f'],
    ['import json, helper'],
    ['x = 1; import helper'],
    ['import'],
    ['import importlib'],
    ['__import__("helper")'],
    ['import runpy'],
    ['import subprocess'],
    ['import os\nos.system("ls")'],
    ['import os\nos.popen("ls")'],
  ])('%j loads other code', source => {
    expect(scriptLoadsOnlyStandardCode({ runtime: 'python', source })).toBe(false);
  });
});

describe('scriptLoadsOnlyStandardCode for node', () => {
  test.each([
    ['const x = 1;'],
    ["const fs = require('fs');"],
    ["const p = require('node:path');"],
    ["import fs from 'fs';"],
    ["import('node:os').then(() => {});"],
  ])('%j is built in', source => {
    expect(scriptLoadsOnlyStandardCode({ runtime: 'node', source })).toBe(true);
  });

  test.each([
    ["const h = require('./helper.js');"],
    ["const l = require('lodash');"],
    ['const m = require(name);'],
    ["import('./helper.js');"],
    ["import helper from './helper.js';"],
    ["require('child_process').execSync('ls');"],
    ["require('node:vm');"],
    ["const x = require('fs') + require(y);"],
  ])('%j loads other code', source => {
    expect(scriptLoadsOnlyStandardCode({ runtime: 'node', source })).toBe(false);
  });
});
