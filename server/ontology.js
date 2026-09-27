// GitWiki ontology: entity types, typed relations and the tag taxonomy. Stored in the repo at
// _system/ontology.yml (versioned like everything else) and edited by KM from the admin panel.
import YAML from 'yaml';
import { normalizeTag, normalizeName } from '../shared/doc.js';

export const ONTOLOGY_PATH = '_system/ontology.yml';

export const BUILTIN_RELATIONS = [
  { name: 'links_to', label: 'links to', inverse: 'linked_from', builtin: true },
  { name: 'embeds', label: 'embeds', inverse: 'embedded_in', builtin: true },
  { name: 'tagged_with', label: 'tagged with', inverse: 'tag_of', builtin: true },
  { name: 'child_of', label: 'child of', inverse: 'parent_of', builtin: true },
  { name: 'in_space', label: 'in space', inverse: 'contains', builtin: true },
  { name: 'mentions', label: 'mentions', inverse: 'mentioned_in', builtin: true },
  { name: 'authored_by', label: 'authored by', inverse: 'authored', builtin: true },
];

export const DEFAULT_ONTOLOGY = {
  version: 1,
  namespace: 'https://gitwiki.example/ontology#',
  types: [
    { name: 'Document', description: 'General documentation page (default type).', properties: [] },
    { name: 'Person', description: 'A person in the organisation.', properties: [
      { name: 'email', datatype: 'string' }, { name: 'member_of', datatype: 'link', range: ['Team'] }] },
    { name: 'Team', description: 'An organisational unit.', properties: [
      { name: 'lead', datatype: 'link', range: ['Person'] }] },
    { name: 'System', description: 'A software system, service or component.', properties: [
      { name: 'owner', datatype: 'link', range: ['Person', 'Team'], required: true },
      { name: 'lifecycle', datatype: 'enum', values: ['planned', 'active', 'deprecated', 'retired'] },
      { name: 'depends_on', datatype: 'link', range: ['System'] }] },
    { name: 'Project', description: 'A time-bound initiative.', properties: [
      { name: 'owner', datatype: 'link', range: ['Person', 'Team'] }, { name: 'due', datatype: 'date' }] },
    { name: 'Process', description: 'A repeatable way of working / runbook.', properties: [
      { name: 'owner', datatype: 'link', range: ['Person', 'Team'], required: true }] },
    { name: 'Policy', description: 'A governed rule. Requires periodic review.', properties: [
      { name: 'owner', datatype: 'link', range: ['Person', 'Team'], required: true },
      { name: 'review_by', datatype: 'date', required: true }] },
    { name: 'Concept', description: 'A glossary term or domain concept.', properties: [
      { name: 'defined_by', datatype: 'link' }] },
    { name: 'Decision', description: 'An architecture/business decision record.', properties: [
      { name: 'decision_status', datatype: 'enum', values: ['proposed', 'accepted', 'superseded', 'rejected'] },
      { name: 'supersedes', datatype: 'link', range: ['Decision'] }] },
    { name: 'Meeting', description: 'Meeting notes.', properties: [{ name: 'date', datatype: 'date' }] },
    { name: 'HowTo', description: 'Task-oriented guide.', properties: [] },
  ],
  relations: [
    { name: 'owner', label: 'owned by', inverse: 'owns', domain: ['System', 'Process', 'Policy', 'Project'], range: ['Person', 'Team'] },
    { name: 'depends_on', label: 'depends on', inverse: 'required_by', domain: ['System'], range: ['System'] },
    { name: 'part_of', label: 'part of', inverse: 'has_part' },
    { name: 'supersedes', label: 'supersedes', inverse: 'superseded_by' },
    { name: 'related_to', label: 'related to', inverse: 'related_to', symmetric: true },
    { name: 'implements', label: 'implements', inverse: 'implemented_by' },
    { name: 'defined_by', label: 'defined by', inverse: 'defines' },
    { name: 'member_of', label: 'member of', inverse: 'has_member', domain: ['Person'], range: ['Team'] },
    { name: 'lead', label: 'led by', inverse: 'leads', domain: ['Team'], range: ['Person'] },
  ],
  tags: [
    { name: 'engineering', description: 'Engineering and technical content.', synonyms: ['eng'] },
    { name: 'runbook', description: 'Operational procedures.', synonyms: ['playbook'] },
    { name: 'policy', description: 'Governance and policies.' },
    { name: 'onboarding', description: 'Material for new joiners.' },
  ],
};

export class Ontology {
  constructor(data = DEFAULT_ONTOLOGY) { this.load(data); }

  static parse(text) {
    let data;
    try { data = YAML.parse(text); } catch (e) { throw Object.assign(new Error('Invalid ontology YAML: ' + e.message), { status: 400 }); }
    return new Ontology(data);
  }

  load(data) {
    const errs = Ontology.check(data);
    if (errs.length) throw Object.assign(new Error('Invalid ontology: ' + errs.join('; ')), { status: 400, errors: errs });
    this.data = data;
    this.types = new Map(data.types.map(t => [t.name, t]));
    this.relations = new Map([...BUILTIN_RELATIONS, ...(data.relations || [])].map(r => [r.name, r]));
    this.tagIndex = new Map();
    for (const t of data.tags || []) {
      const canon = normalizeTag(t.name);
      this.tagIndex.set(canon, { ...t, name: canon });
      for (const s of t.synonyms || []) this.tagIndex.set(normalizeTag(s), { ...t, name: canon, synonymOf: canon });
    }
  }

  static check(data) {
    const errs = [];
    if (!data || typeof data !== 'object') return ['ontology must be a mapping'];
    if (!Array.isArray(data.types) || !data.types.length) errs.push('types must be a non-empty list');
    const names = new Set();
    for (const t of data.types || []) {
      if (!t || !t.name || !/^[A-Za-z][\w]*$/.test(t.name)) errs.push(`invalid type name: ${t && t.name}`);
      if (names.has(t.name)) errs.push(`duplicate type: ${t.name}`);
      names.add(t.name);
    }
    const rels = new Set(BUILTIN_RELATIONS.map(r => r.name));
    for (const r of data.relations || []) {
      if (!r || !r.name || !/^[a-z][\w]*$/.test(r.name)) errs.push(`invalid relation name: ${r && r.name}`);
      if (rels.has(r.name)) errs.push(`duplicate relation: ${r.name}`);
      rels.add(r.name);
      for (const t of [...(r.domain || []), ...(r.range || [])]) if (!names.has(t)) errs.push(`relation ${r.name} references unknown type ${t}`);
    }
    for (const t of data.types || []) for (const p of t.properties || []) {
      for (const rt of p.range || []) if (!names.has(rt)) errs.push(`property ${t.name}.${p.name} references unknown type ${rt}`);
    }
    return errs;
  }

  toYAML() { return YAML.stringify(this.data, { lineWidth: 0 }); }

  canonicalTag(tag) {
    const n = normalizeTag(tag);
    const e = this.tagIndex.get(n);
    return e && e.synonymOf ? e.synonymOf : n;
  }

  /**
   * Validate a page's type, properties, relations and tags. `resolveType(target)` returns the
   * type of a linked page (or null if missing). Returns a list of {level, message}.
   */
  validate({ type, data = {}, relations = [], tags = [] }, resolveType = () => undefined) {
    const out = [];
    const t = this.types.get(type || 'Document');
    if (type && !t) out.push({ level: 'warning', code: 'unknown-type', message: `Unknown page type "${type}".` });
    if (t) {
      for (const p of t.properties || []) {
        const has = data[p.name] !== undefined && data[p.name] !== '' ||
          relations.some(r => r.rel === p.name);
        if (p.required && !has) out.push({ level: 'warning', code: 'missing-property', message: `${t.name} pages should define "${p.name}".` });
        if (has && p.datatype === 'enum' && data[p.name] !== undefined && !(p.values || []).includes(String(data[p.name]))) {
          out.push({ level: 'warning', code: 'bad-enum', message: `"${p.name}" should be one of: ${(p.values || []).join(', ')}.` });
        }
        if (has && p.datatype === 'date' && data[p.name] !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(String(data[p.name] instanceof Date ? data[p.name].toISOString() : data[p.name]))) {
          out.push({ level: 'warning', code: 'bad-date', message: `"${p.name}" should be a date (YYYY-MM-DD).` });
        }
      }
    }
    for (const r of relations) {
      const def = this.relations.get(r.rel);
      if (!def) { out.push({ level: 'info', code: 'unknown-relation', message: `Relation "${r.rel}" is not in the ontology (treated as related_to).` }); continue; }
      if (def.domain && type && !def.domain.includes(type)) {
        out.push({ level: 'warning', code: 'domain', message: `"${r.rel}" is not expected on ${type} pages.` });
      }
      const tt = resolveType(r.target);
      if (tt === null) out.push({ level: 'warning', code: 'missing-target', message: `"${r.rel}" points to missing page "${r.target}".` });
      else if (tt && def.range && !def.range.includes(tt)) {
        out.push({ level: 'warning', code: 'range', message: `"${r.rel}" should point to ${def.range.join('/')} (found ${tt}).` });
      }
    }
    for (const tag of tags) {
      const e = this.tagIndex.get(normalizeTag(tag));
      if (e && e.deprecated) out.push({ level: 'warning', code: 'deprecated-tag', message: `Tag #${tag} is deprecated${e.replaced_by ? `; use #${e.replaced_by}` : ''}.` });
      else if (e && e.synonymOf) out.push({ level: 'info', code: 'synonym-tag', message: `#${tag} is a synonym of #${e.synonymOf}.` });
    }
    return out;
  }

  /** OWL/RDFS schema of the ontology itself, in Turtle. */
  schemaTurtle() {
    const ns = this.data.namespace || DEFAULT_ONTOLOGY.namespace;
    const lines = [`@prefix gw: <${ns}> .`, '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .', ''];
    for (const t of this.data.types) {
      lines.push(`gw:${t.name} a owl:Class ; rdfs:label ${lit(t.name)}${t.description ? ` ; rdfs:comment ${lit(t.description)}` : ''} .`);
    }
    for (const r of this.relations.values()) {
      let l = `gw:${r.name} a owl:ObjectProperty ; rdfs:label ${lit(r.label || r.name)}`;
      if (r.inverse && r.inverse !== r.name) l += ` ; owl:inverseOf gw:${r.inverse}`;
      if (r.domain) l += ` ; rdfs:domain ${r.domain.map(d => 'gw:' + d).join(', ')}`;
      if (r.range) l += ` ; rdfs:range ${r.range.map(d => 'gw:' + d).join(', ')}`;
      lines.push(l + ' .');
    }
    return lines.join('\n') + '\n';
  }

  relationLabel(name) { const r = this.relations.get(name); return r ? r.label || name : name; }
  isKnownName(n) { return this.types.has(n) || this.relations.has(normalizeName(n)); }
}

export function lit(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
