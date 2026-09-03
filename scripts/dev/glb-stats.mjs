#!/usr/bin/env node
/**
 * GLB 실측기 — 익스포트 결과의 삼각형 수·프리미티브 수·크기·바운딩박스를 읽는다.
 *
 * Blender 쪽 `report()` 는 **모디파이어 적용 전** 메시를 센다. 베벨이 붙으면 실제
 * 익스포트 결과와 벌어지므로, 예산(§2)은 이 스크립트가 읽은 값으로 판단한다.
 *
 * ⚠️ 바운딩은 **노드 변환을 먹여서** 계산한다. accessor 의 min/max 는 메시 로컬 좌표라
 * 노드에 translation 이 있으면 엉뚱한 값이 나온다 — 초판이 그 버그로 `rack-42u.glb` 의
 * 바닥을 y=-1.0 으로 읽었다. 실제로는 노드가 +1.0 올려놔서 바닥이 y=0 이다.
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

  // 노드 트리를 돌며 누적 오프셋(translation)과 scale 을 메시 바운딩에 먹인다.
  // 회전은 무시한다 — 이 프로젝트의 GLB 에는 회전 노드가 없고, 있으면 아래 경고가 뜬다.
  const visit = (nodeIndex, offset, scale) => {
    const node = json.nodes[nodeIndex]
    if (node.rotation && node.rotation.some((v, i) => v !== (i === 3 ? 1 : 0))) {
      console.warn(`  ⚠️ ${node.name ?? nodeIndex}: 회전 노드가 있어 바운딩이 부정확하다`)
    }
    const s = node.scale ?? [1, 1, 1]
    const t = node.translation ?? [0, 0, 0]
    const nextScale = scale.map((v, i) => v * s[i])
    const nextOffset = offset.map((v, i) => v + t[i] * scale[i])

    if (node.mesh != null) {
      for (const prim of json.meshes[node.mesh].primitives) {
        primitives += 1
        const count = prim.indices != null
          ? json.accessors[prim.indices].count
          : json.accessors[prim.attributes.POSITION].count
        tris += count / 3
        const pos = json.accessors[prim.attributes.POSITION]
        if (pos.min && pos.max) {
          for (let i = 0; i < 3; i += 1) {
            const lo = pos.min[i] * nextScale[i] + nextOffset[i]
            const hi = pos.max[i] * nextScale[i] + nextOffset[i]
            min[i] = Math.min(min[i], lo, hi)
            max[i] = Math.max(max[i], lo, hi)
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, nextOffset, nextScale)
  }

  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(root, [0, 0, 0], [1, 1, 1])

  const textures = (json.images ?? []).length
  const size = (buf.length / 1024).toFixed(1)
  const dims = max.map((v, i) => (v - min[i]).toFixed(3)).join(' x ')
  console.log(
    `${basename(path).padEnd(26)} ${String(tris).padStart(6)} tris  ` +
    `${String(primitives).padStart(3)} prim  ${size.padStart(7)} KB  ` +
    `${dims}  floorY=${min[1].toFixed(4)}  materials=${(json.materials ?? []).length}  images=${textures}`,
  )
}
