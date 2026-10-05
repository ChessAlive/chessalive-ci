// A code release must never advertise motions whose content was not published.
// This gate is read-only; publishing remains a separate, guarded operation.
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function requiredContent(prod, slices, movements = []) {
  const issues = [];
  const uploads = new Set();
  const index = key => new Map((prod[key] ?? []).map(record => [record.id, record]));
  const clips = index('animationClips');
  const pieces = index('pieceSets');
  const animations = index('animationSets');
  const liveMovements = index('movementSets');
  for (const expected of movements) {
    const actual = liveMovements.get(expected.id);
    if (!actual || actual.name !== expected.name || actual.ceremonies?.checkmate?.story !== expected.ceremonies?.checkmate?.story)
      issues.push(`celebration ${expected.id}: required movement type not published`);
  }
  const requirePath = value => {
    if (typeof value === 'string' && value.startsWith('/uploads/')) uploads.add(value);
  };
  for (const slice of slices) {
    for (const expected of slice.animationClips ?? []) {
      const actual = clips.get(expected.id);
      if (!actual || actual.name !== expected.name || actual.sourceGlbPath !== expected.sourceGlbPath)
        issues.push(`clip ${expected.id}: required motion/body not published`);
      requirePath(expected.sourceGlbPath);
    }
    for (const expected of slice.pieceSets ?? []) {
      const actual = pieces.get(expected.id);
      for (const [piece, body] of Object.entries(expected.pieces ?? {})) {
        if (!actual || actual.pieces?.[piece]?.glbPath !== body.glbPath)
          issues.push(`piece ${expected.id}/${piece}: required body not published`);
        requirePath(body.glbPath);
      }
    }
    for (const expected of slice.animationSets ?? []) {
      const actual = animations.get(expected.id);
      if (!actual) issues.push(`animation set ${expected.id}: not published`);
      for (const [piece, roles] of Object.entries(expected.ceremonies?.clipRolesByPiece ?? {}))
        for (const [role, id] of Object.entries(roles))
          if (actual?.ceremonies?.clipRolesByPiece?.[piece]?.[role] !== id)
            issues.push(`cast ${expected.id}/${piece}/${role}: required binding not published`);
    }
  }
  return { issues, uploads: [...uploads].sort() };
}

export async function verifyContent({ sourceRoot, publicUrl, fetchImpl = fetch }) {
  const config = JSON.parse(await readFile(resolve(sourceRoot, 'content/catalog.config.json'), 'utf8'));
  if (!Array.isArray(config.sets) || !config.sets.length) throw new Error('Content config has no owned sets');
  const slices = await Promise.all(config.sets.map(async entry => {
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.animationSetId)) throw new Error('Invalid animation set id');
    return JSON.parse(await readFile(resolve(sourceRoot, 'content/catalog', `${entry.animationSetId}.json`), 'utf8'));
  }));
  const movements = await Promise.all((config.movementSetIds ?? []).map(async id => {
    if (!/^movement-set-[a-z0-9-]+$/.test(id)) throw new Error('Invalid movement set id');
    return JSON.parse(await readFile(resolve(sourceRoot, 'content/movement-sets', `${id}.json`), 'utf8'));
  }));
  const base = new URL(publicUrl);
  const response = await fetchImpl(new URL('/catalog/state', base), {
    headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Public catalog returned HTTP ${response.status}`);
  const prod = await response.json();
  if (!Array.isArray(prod.animationClips) || !Array.isArray(prod.pieceSets) || !Array.isArray(prod.animationSets))
    throw new Error('Public catalog is not a complete catalog document');
  const { issues, uploads } = requiredContent(prod, slices, movements);
  if (issues.length) throw new Error(`Required content is not live (${issues.length} mismatches):\n${issues.slice(0, 12).join('\n')}\nPublish the reviewed content with content/publish-content.sh before releasing this code.`);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, uploads.length) }, async () => {
    while (next < uploads.length) {
      const path = uploads[next++];
      const asset = await fetchImpl(new URL(path, base), { method: 'HEAD', signal: AbortSignal.timeout(30000) });
      const type = asset.headers.get('content-type') ?? '';
      if (!asset.ok || type.includes('text/html') || Number(asset.headers.get('content-length')) <= 0)
        throw new Error(`Required model ${path} is unavailable (HTTP ${asset.status}, ${type})`);
    }
  }));
  return { revision: prod.appStateRevision, worlds: slices.length, models: uploads.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const result = await verifyContent({ sourceRoot: process.env.SOURCE_ROOT ?? '/opt/chessalive', publicUrl: process.env.PUBLIC_URL ?? 'https://chessalive.com' });
    console.log(`Content readiness passed: revision ${result.revision}, ${result.worlds} worlds, ${result.models} required models publicly available`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
