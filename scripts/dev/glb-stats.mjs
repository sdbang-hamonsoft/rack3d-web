#!/usr/bin/env node
/**
 * GLB 실측기 — 익스포트 결과의 삼각형 수·프리미티브 수·크기·바운딩박스를 읽는다.
 *
 * Blender 쪽 `report()` 는 **모디파이어 적용 전** 메시를 센다. 베벨이 붙으면 실제
 * 익스포트 결과와 벌어지므로, 예산(§2)은 이 스크립트가 읽은 값으로 판단한다.
 *
 * 사용: node scripts/dev/glb-stats.mjs public/models/objects/*.glb
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB')
  let offset = 12
  let json = null
  let bin = null
  while (offset < buf.length) {
    const length = buf.readUInt32LE(offset)
    const type = buf.readUInt32LE(offset + 4)
    const start = offset + 8
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(start, start + length).toString('utf8'))
    else if (type === 0x004e4942) bin = buf.subarray(start, start + length)
    offset = start + length
  }
  return { json, bin }
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

for (const path of process.argv.slice(2)) {
  const buf = readFileSync(path)
  const { json } = parseGlb(buf)
  let tris = 0
  let primitives = 0
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]

  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      primitives += 1
      const count = prim.indices != null
        ? json.accessors[prim.indices].count
        : json.accessors[prim.attributes.POSITION].count
      tris += count / 3
      const pos = json.accessors[prim.attributes.POSITION]
      if (pos.min && pos.max) {
        for (let i = 0; i < 3; i += 1) {
          min[i] = Math.min(min[i], pos.min[i])
          max[i] = Math.max(max[i], pos.max[i])
        }
      }
    }
  }

  const textures = (json.images ?? []).length
  const size = (buf.length / 1024).toFixed(1)
  const dims = max.map((v, i) => (v - min[i]).toFixed(3)).join(' x ')
  console.log(
    `${basename(path).padEnd(26)} ${String(tris).padStart(6)} tris  ` +
    `${String(primitives).padStart(3)} prim  ${size.padStart(7)} KB  ` +
    `${dims}  floorY=${min[1].toFixed(4)}  materials=${(json.materials ?? []).length}  images=${textures}`,
  )
}
