/**
 * Punto de entrada VPS — sobrescribe require('./database') con la
 * versión local (sin Vercel Blob) antes de cargar el servidor principal.
 */
const Module = require('module');
const path = require('path');

const rootDir = path.join(__dirname, '..');

// Monkey-patch require para que '../database' y './database' apunten a vps/database.js
const _resolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === './database' || request === '../database') {
    return path.join(__dirname, 'database.js');
  }
  return _resolveFilename.call(this, request, parent, isMain, options);
};

// Asegurar que las rutas relativas de server.js funcionen desde la raíz
process.chdir(rootDir);

require(path.join(rootDir, 'server.js'));
