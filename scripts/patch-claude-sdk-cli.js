#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function patchClaudeSdkCli() {
  const cliPath = path.join(
    process.cwd(),
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'cli.js'
  );

  if (!fs.existsSync(cliPath)) {
    console.warn('[postinstall] claude-agent-sdk cli.js not found, skip patch');
    return;
  }

  const oldSnippet =
    'BS=(A)=>{let Q=g4([A]);return NL(`cygpath -u ${Q}`,{shell:dM1()}).toString().trim()},B0Q=(A)=>{let Q=g4([A]);return NL(`cygpath -w ${Q}`,{shell:dM1()}).toString().trim()};';

  const newSnippet =
    'BS=(A)=>{let Q=String(A??"").trim().replace(/^[' +
    "'\"" +
    ']+|[' +
    "'\"" +
    ']+$/g,"");if(/^[a-zA-Z]:[\\\\/]/.test(Q)){let B=Q[0].toLowerCase(),G=Q.slice(2).replace(/\\\\/g,"/");return`/${B}${G.startsWith("/")?"":"/"}${G}`}if(Q.startsWith("/"))return Q;try{let B=g4([A]);return NL(`cygpath -u ${B}`,{shell:dM1()}).toString().trim()}catch{return Q.replace(/\\\\/g,"/")}},B0Q=(A)=>{let Q=String(A??"").trim().replace(/^[' +
    "'\"" +
    ']+|[' +
    "'\"" +
    ']+$/g,"");if(/^\\/[a-zA-Z](?:\\/|$)/.test(Q)){let B=Q[1].toUpperCase(),G=Q.slice(2).replace(/\\//g,"\\\\");return`${B}:${G}`}if(/^[a-zA-Z]:[\\\\/]/.test(Q))return Q.replace(/\\//g,"\\\\");try{let B=g4([A]);return NL(`cygpath -w ${B}`,{shell:dM1()}).toString().trim()}catch{if(/^\\/[a-zA-Z](?:\\/|$)/.test(Q)){let B=Q[1].toUpperCase(),G=Q.slice(2).replace(/\\//g,"\\\\");return`${B}:${G}`}return Q.replace(/\\//g,"\\\\")}};';

  const current = fs.readFileSync(cliPath, 'utf8');
  if (current.includes(newSnippet)) {
    console.log('[postinstall] claude-agent-sdk cli.js already patched');
    return;
  }

  if (!current.includes(oldSnippet)) {
    console.warn('[postinstall] target cygpath snippet not found in claude-agent-sdk cli.js, skip patch');
    return;
  }

  const patched = current.replace(oldSnippet, newSnippet);
  fs.writeFileSync(cliPath, patched, 'utf8');
  console.log('[postinstall] patched claude-agent-sdk cli.js cygpath fallback');
}

try {
  patchClaudeSdkCli();
} catch (error) {
  console.warn(
    '[postinstall] failed to patch claude-agent-sdk cli.js:',
    error instanceof Error ? error.message : String(error)
  );
}

