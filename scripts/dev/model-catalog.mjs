import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const root = document.querySelector('main')
const select = document.querySelector('#model')
const status = document.querySelector('#status')
const entries = [
  ['objects/ups', 'UPS'], ['objects/temperature-humidity-sensor', '온습도센서'],
  ['objects/battery-rack', '배터리랙'], ['objects/gas-suppression', '가스소화설비'],
  ['objects/door', '도어 + 접점센서'], ['objects/water-leak-sensor', '누수감지'],
  ...['server', 'network'].flatMap(kind => Array.from({ length: 10 }, (_, i) =>
    [`standard-${kind}-${i + 1}u`, `${kind === 'server' ? '표준서버' : '표준네트워크'} ${i + 1}U`])),
]
for (const [value, label] of entries) select.add(new Option(label, value))
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setClearColor('#101820')
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.4
root.append(renderer.domElement)
const scene = new THREE.Scene()
const pmrem = new THREE.PMREMGenerator(renderer)
const room = new RoomEnvironment()
const studio = pmrem.fromScene(room, 0.04)
scene.environment = studio.texture
room.dispose()
pmrem.dispose()
scene.add(new THREE.HemisphereLight('#e6f2ff', '#6c7378', 3))
for (const [x, y, z, intensity] of [[-3, 4, 5, 4], [3, 2, -3, 3]]) {
  const light = new THREE.DirectionalLight('#ffffff', intensity)
  light.position.set(x, y, z)
  scene.add(light)
}
const camera = new THREE.PerspectiveCamera(38, 1, .001, 100)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
let current, span = 2, center = new THREE.Vector3(), ticket = 0
const loader = new GLTFLoader()
function dispose(group) {
  group?.traverse(obj => {
    if (!obj.isMesh) return
    obj.geometry.dispose()
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of mats) mat.dispose()
  })
}
function view(kind = 'iso') {
  const dir = kind === 'front' ? new THREE.Vector3(0, .05, 1) : kind === 'rear' ? new THREE.Vector3(0, .05, -1) : new THREE.Vector3(1, .55, 1.5)
  const distance = span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * Math.max(1, 1 / camera.aspect) * 1.35
  camera.position.copy(center).addScaledVector(dir.normalize(), distance)
  controls.target.copy(center)
  controls.update()
}
async function load() {
  const id = ++ticket
  status.textContent = '불러오는 중…'
  document.body.dataset.loaded = ''
  try {
    const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${select.value}.glb?v=14`)
    if (id !== ticket) { dispose(gltf.scene); return }
    if (current) { scene.remove(current); dispose(current) }
    current = gltf.scene
    scene.add(current)
    const box = new THREE.Box3().setFromObject(current)
    const size = box.getSize(new THREE.Vector3())
    center = box.getCenter(new THREE.Vector3())
    span = size.length() // bounding-sphere diameter keeps every viewing angle in frame
    status.textContent = `${select.selectedOptions[0].text} · 외곽 ${Math.round(size.x * 1000)} × ${Math.round(size.z * 1000)} × ${Math.round(size.y * 1000)} mm (폭·깊이·높이)`
    document.body.dataset.loaded = select.value
    view()
  } catch (error) { status.textContent = `로딩 실패: ${error.message}` }
}
select.addEventListener('change', load)
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)))
new ResizeObserver(() => {
  renderer.setSize(root.clientWidth, root.clientHeight)
  camera.aspect = root.clientWidth / root.clientHeight
  camera.updateProjectionMatrix()
  view()
}).observe(root)
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera) })
load()
