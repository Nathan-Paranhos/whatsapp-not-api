/**
 * Valida os diagramas mermaid do README renderizando cada um de verdade.
 *
 * O GitHub decodifica entidades HTML antes de passar o texto ao mermaid, então
 * truques como `&#123;` não protegem chaves dentro de um nó — só aspas em volta
 * do rótulo protegem. Este script pega esse tipo de erro antes do push.
 *
 *   node scripts/check-mermaid.js [arquivo.md]
 */
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
const BLOCK = /```mermaid\n([\s\S]*?)\n```/g;

function extractDiagrams(markdown) {
  const lines = markdown.split('\n');
  const diagrams = [];
  let match;
  while ((match = BLOCK.exec(markdown)) !== null) {
    const line = lines.findIndex((_, index) =>
      lines.slice(0, index + 1).join('\n').length >= match.index) + 1;
    diagrams.push({ line, code: match[1] });
  }
  return diagrams;
}

async function main() {
  const file = path.resolve(process.argv[2] || 'README.md');
  const diagrams = extractDiagrams(fs.readFileSync(file, 'utf8'));
  if (!diagrams.length) {
    console.log(`Nenhum bloco mermaid em ${path.basename(file)}.`);
    return;
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let failures = 0;
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ url: MERMAID_CDN, type: 'module' });
    await page.evaluate(async (cdn) => {
      const mermaid = (await import(cdn)).default;
      mermaid.initialize({ startOnLoad: false });
      window.mermaid = mermaid;
    }, MERMAID_CDN);

    for (const [index, diagram] of diagrams.entries()) {
      const result = await page.evaluate(async (raw, id) => {
        // O GitHub decodifica entidades HTML antes de entregar o texto ao
        // mermaid. Sem reproduzir isso aqui, `&#123;` passaria no teste e
        // quebraria no GitHub — que foi exatamente o bug original.
        const decoder = document.createElement('textarea');
        decoder.innerHTML = raw;
        const code = decoder.value;

        try {
          await window.mermaid.parse(code);
          const { svg } = await window.mermaid.render(`d${id}`, code);
          return { ok: true, size: svg.length, decoded: code !== raw };
        } catch (error) {
          return { ok: false, message: String(error?.message || error), decoded: code !== raw };
        }
      }, diagram.code, index);

      const kind = diagram.code.trim().split(/\s|\n/)[0];
      if (result.ok) {
        const note = result.decoded ? ' (com entidades HTML decodificadas)' : '';
        console.log(`  ok    linha ${diagram.line} · ${kind} · ${result.size} bytes de SVG${note}`);
      } else {
        failures += 1;
        console.error(`  ERRO  linha ${diagram.line} · ${kind}\n${indent(result.message)}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('');
  if (failures) {
    console.error(`${failures} de ${diagrams.length} diagrama(s) não renderizam.`);
    process.exitCode = 1;
  } else {
    console.log(`${diagrams.length} diagrama(s) renderizam sem erro.`);
  }
}

function indent(text) {
  return text.split('\n').map((line) => `        ${line}`).join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
