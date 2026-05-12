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

  let current = fs.readFileSync(cliPath, 'utf8');
  let patched = current;

  if (patched.includes(newSnippet)) {
    console.log('[postinstall] claude-agent-sdk cli.js already patched');
  } else if (!patched.includes(oldSnippet)) {
    console.warn('[postinstall] target cygpath snippet not found in claude-agent-sdk cli.js, skip patch');
  } else {
    patched = patched.replace(oldSnippet, newSnippet);
    console.log('[postinstall] patched claude-agent-sdk cli.js cygpath fallback');
  }

  const oldExploreModelSnippet =
    'model:"haiku",getSystemPrompt:()=>JH5,criticalSystemReminder_EXPERIMENTAL:"CRITICAL: This is a READ-ONLY task. You CANNOT edit, write, or create files."';
  const newExploreModelSnippet =
    'model:"inherit",getSystemPrompt:()=>JH5,criticalSystemReminder_EXPERIMENTAL:"CRITICAL: This is a READ-ONLY task. You CANNOT edit, write, or create files."';

  if (patched.includes(newExploreModelSnippet)) {
    console.log('[postinstall] claude-agent-sdk Explore agent model already patched');
  } else if (!patched.includes(oldExploreModelSnippet)) {
    console.warn('[postinstall] target Explore agent model snippet not found in claude-agent-sdk cli.js, skip patch');
  } else {
    patched = patched.replace(oldExploreModelSnippet, newExploreModelSnippet);
    console.log('[postinstall] patched claude-agent-sdk Explore agent to inherit model');
  }

  if (patched !== current) {
    fs.writeFileSync(cliPath, patched, 'utf8');
  }
}

try {
  patchClaudeSdkCli();
} catch (error) {
  console.warn(
    '[postinstall] failed to patch claude-agent-sdk cli.js:',
    error instanceof Error ? error.message : String(error)
  );
}
