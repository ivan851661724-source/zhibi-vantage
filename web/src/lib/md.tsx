// 极简 Markdown → React 节点渲染器（报告页专用）
// 设计：不使用 dangerouslySetInnerHTML（XSS 零面）——全部输出 React 元素；
// 支持报告会用到的语法：#/##/### 标题、- 列表、> 引用块、**粗体**、[文本](链接)、--- 分隔线、| 表格 |、其余按段落。
'use client';

import { Fragment, type ReactNode } from 'react';

// 行内解析：**bold** 与 [text](url)；URL 只允许 http(s)（防 javascript: 注入）
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={keyPrefix + 'b' + i}>{tok.slice(2, -2)}</strong>);
    } else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (mm) {
        const href = mm[2].trim();
        const safe = /^https?:\/\//i.test(href);
        out.push(
          safe ? (
            <a key={keyPrefix + 'a' + i} href={href} target="_blank" rel="noopener noreferrer nofollow">{mm[1]}</a>
          ) : (
            <span key={keyPrefix + 'a' + i}>{mm[1]}</span>
          ),
        );
      } else {
        out.push(tok);
      }
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(md: string): ReactNode {
  const lines = String(md || '').split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] | null = null;
  let table: string[] | null = null;
  let quote: string[] | null = null;
  let k = 0;

  const flushList = () => { if (list) { blocks.push(<ul key={'ul' + k++}>{list.map((li, j) => <li key={j}>{inline(li, 'li' + k + j)}</li>)}</ul>); list = null; } };
  const flushTable = () => {
    if (table) {
      const rows = table.filter(r => !/^\s*\|[\s|:-]+\|\s*$/.test(r)).map(r => r.split('|').slice(1, -1).map(c => c.trim()));
      if (rows.length) {
        const [head, ...body] = rows;
        blocks.push(
          <table key={'tb' + k++} className="md-table">
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, 'th' + j)}</th>)}</tr></thead>
            <tbody>{body.map((r, j) => <tr key={j}>{r.map((c, i2) => <td key={i2}>{inline(c, 'td' + j + i2)}</td>)}</tr>)}</tbody>
          </table>,
        );
      }
      table = null;
    }
  };
  const flushQuote = () => { if (quote) { blocks.push(<blockquote key={'bq' + k++} className="md-quote">{quote.map((q, j) => <p key={j}>{inline(q, 'bq' + j)}</p>)}</blockquote>); quote = null; } };
  const flushAll = () => { flushList(); flushTable(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,4}\s/.test(line)) {
      flushAll();
      const level = line.match(/^#+/)![0].length;
      const text = line.replace(/^#+\s*/, '');
      const Tag = (level <= 1 ? 'h2' : level === 2 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={'h' + k++}>{inline(text, 'h' + k)}</Tag>);
      continue;
    }
    if (/^---+\s*$/.test(line)) { flushAll(); blocks.push(<hr key={'hr' + k++} />); continue; }
    if (/^\s*-\s+/.test(line)) { flushTable(); flushQuote(); (list = list || []).push(line.replace(/^\s*-\s+/, '')); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); flushQuote(); (table = table || []).push(line); continue; }
    if (/^>\s?/.test(line)) { flushList(); flushTable(); (quote = quote || []).push(line.replace(/^>\s?/, '')); continue; }
    if (!line.trim()) { flushAll(); continue; }
    flushAll();
    blocks.push(<p key={'p' + k++}>{inline(line, 'p' + k)}</p>);
  }
  flushAll();
  return <Fragment>{blocks}</Fragment>;
}
