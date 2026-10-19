/**
 * Minimal, safe XML parser for financial messages (ISO 20022, OFX 2.x).
 * Safe by construction: DOCTYPE/DTDs are rejected (no XXE, no entity expansion attacks);
 * only the five predefined entities and numeric character references are decoded.
 * Namespaces are kept as prefixes; `local` gives the unprefixed name.
 */
export interface XmlElement {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export class XmlError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`XML error at ${offset}: ${message}`);
    this.name = 'XmlError';
  }
}

const MAX_DEPTH = 64;
const MAX_NODES = 200_000;

function decodeEntities(s: string, offset: number): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);?/g, (m, ent: string) => {
    if (!m.endsWith(';')) throw new XmlError(`malformed entity ${m}`, offset);
    switch (ent) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = ent.startsWith('#x') ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) throw new XmlError(`invalid character reference ${m}`, offset);
        return String.fromCodePoint(code);
      }
    }
  });
}

export function parseXml(input: string): XmlElement {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (/<!DOCTYPE/i.test(s)) throw new XmlError('DOCTYPE declarations are not allowed', s.search(/<!DOCTYPE/i));
  if (/<!ENTITY/i.test(s)) throw new XmlError('ENTITY declarations are not allowed', s.search(/<!ENTITY/i));
  const root: XmlElement = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let i = 0;
  let nodes = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const textEnd = lt === -1 ? s.length : lt;
    if (textEnd > i) {
      const raw = s.slice(i, textEnd);
      if (raw.trim()) stack[stack.length - 1]!.text += decodeEntities(raw, i);
    }
    if (lt === -1) break;
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt);
      if (end === -1) throw new XmlError('unterminated processing instruction', lt);
      i = end + 2;
      continue;
    }
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt);
      if (end === -1) throw new XmlError('unterminated comment', lt);
      i = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt);
      if (end === -1) throw new XmlError('unterminated CDATA', lt);
      stack[stack.length - 1]!.text += s.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    const gt = s.indexOf('>', lt);
    if (gt === -1) throw new XmlError('unterminated tag', lt);
    const tag = s.slice(lt + 1, gt);
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlError(`mismatched closing tag </${name}>`, lt);
      i = gt + 1;
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(body.trim());
    if (!m) throw new XmlError(`invalid tag <${tag}>`, lt);
    const name = m[1]!;
    const attrs: Record<string, string> = {};
    const attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[2]!))) attrs[am[1]!] = decodeEntities(am[3] ?? am[4] ?? '', lt);
    const el: XmlElement = { name, local: name.includes(':') ? name.split(':').pop()! : name, attrs, children: [], text: '' };
    if (++nodes > MAX_NODES) throw new XmlError('document too large', lt);
    stack[stack.length - 1]!.children.push(el);
    if (!selfClosing) {
      stack.push(el);
      if (stack.length > MAX_DEPTH) throw new XmlError('document nested too deeply', lt);
    }
    i = gt + 1;
  }
  if (stack.length !== 1) throw new XmlError(`unclosed element <${stack[stack.length - 1]!.name}>`, s.length);
  const docRoot = root.children[0];
  if (!docRoot) throw new XmlError('empty document', 0);
  return docRoot;
}

/** Find direct children by local name. */
export function kids(el: XmlElement | undefined, local: string): XmlElement[] {
  return el ? el.children.filter((c) => c.local === local) : [];
}

export function kid(el: XmlElement | undefined, local: string): XmlElement | undefined {
  return el?.children.find((c) => c.local === local);
}

/** Follow a path of local names, returning the first match. */
export function path(el: XmlElement | undefined, ...locals: string[]): XmlElement | undefined {
  let cur = el;
  for (const l of locals) cur = kid(cur, l);
  return cur;
}

export function textAt(el: XmlElement | undefined, ...locals: string[]): string | undefined {
  const t = path(el, ...locals)?.text.trim();
  return t === undefined || t === '' ? undefined : t;
}

/** Depth-first search for all descendants with a local name. */
export function findAll(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.local === local) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}
