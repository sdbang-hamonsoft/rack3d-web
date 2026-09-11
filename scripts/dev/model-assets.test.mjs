import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { standardModelDepth } from '../../src/rackLayouts.ts'

const loader = new GLTFLoader()
async function load(name) {
  const bytes = readFileSync(new URL(`../../public/models/${name}.glb`, import.meta.url))
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
  gltf.scene.updateMatrixWorld(true)
  return { gltf, box: new THREE.Box3().setFromObject(gltf.scene), bytes }
}
const near = (actual, expected, tolerance = .00002) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)
test('all 20 GLBs fit their U slot, rail width, and both photo surfaces', async () => {
  for (const kind of ['server', 'network']) for (let u = 1; u <= 10; u++) {
    const name = `standard-${kind}-${u}u`
    const { gltf, box, bytes } = await load(name)
    near(box.max.x - box.min.x, .483)
    near(box.min.y, -(u * .04445 - .001) / 2)
    near(box.max.y, (u * .04445 - .001) / 2)
    assert.ok(box.max.z < .419, name + ': face protrudes through photograph')
    assert.ok(box.min.z > .410 - standardModelDepth(name) - .004, name + ': rear protrudes through photograph')
    assert.ok(bytes.length < 400000)
    assert.equal(gltf.parser.json.images?.length ?? 0, 0)
  }
})
test('facility dimensions use latest drawings and floor-centred geometry', async () => {
  for (const [name, w, h, d] of [
    ['cctv', .04, .15, .18],
    ['battery-rack', .8, 2, 1], ['gas-suppression', .45, 2.4, .4],
    ['door', .9, 2.1, .096], ['temperature-humidity-sensor', .08, .12, .058],
  ]) {
    const { box } = await load(`objects/${name}`)
    near(box.min.y, 0)
    near(box.max.y, h)
    near(box.max.x - box.min.x, w)
    near(box.max.z - box.min.z, d, .001)
  }
  const { gltf } = await load('objects/door')
  const glass = gltf.parser.json.materials.find(m => m.name === 'door_glass')
  assert.equal(glass.alphaMode, 'BLEND')
})
