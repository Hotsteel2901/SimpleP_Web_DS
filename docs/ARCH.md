# SimplePlanes 2 (three.js 复刻) — 架构与接口契约

> 所有模块均为原生 ES Module。浏览器端通过 `index.html` 的 importmap 把 `three` 映射到 `./vendor/three.module.js`；
> Node 端（单元测试）通过 `node_modules/three` 解析。**代码中一律写 `import * as THREE from 'three';`**

## 全局约定

- 单位：米 / 秒 / 千克。**Y 轴向上**，X-Z 为水平面。1 单位 = 1 米。
- 地形以原点为中心，覆盖 `x,z ∈ [-size/2, +size/2]`。
- 角度：内部统一用弧度；显示用度。
- 坐标系为 **Y-up 右手系**，机头朝向 `-Z`（与 three.js 摄像机/模型约定一致）。
- 不使用外部资源文件（无贴图/无 mp3），所有音效/音乐实时合成，所有贴图用 Canvas 程序化生成。
- 代码风格：`export class` / `export function`，无副作用模块级代码（除单例导出）。
- 必须能在 `node --check` 下通过；不得使用浏览器专有 API 于模块顶层。

## 模块清单（谁负责）

| 文件 | 内容 | 负责人 |
|---|---|---|
| `src/audio/audio.js` | WebAudio 音效引擎 + 程序化音乐 | 子代理 A |
| `src/audio/music.js` | 音乐编排（和弦进行/曲目） | 子代理 A |
| `src/world/terrain.js` | 程序化地形 + 水面 + 高度查询 | 子代理 B |
| `src/world/landmarks.js` | 地标/建筑/跑道/城市/船只/赛道/圆环/收集物 | 子代理 C |
| `src/ui/widgets.js` | DOM 组件库 + 主题 CSS 注入 | 子代理 D |
| `src/core/*`, `src/build/*`, `src/flight/*`, `src/world/maps.js`, `src/world/sky.js`, `src/game/*`, `src/ui/hud.js`, `src/ui/menu.js`, `src/main.js` | 主程序 | 主代理 |

---

## A. `src/audio/audio.js` + `src/audio/music.js`

```js
// audio.js
export class AudioEngine {
  constructor();
  async init(): Promise<void>;      // 必须由用户手势触发；创建 AudioContext 并 resume
  get ready(): boolean;
  setMasterVolume(v01: number): void;
  setMusicVolume(v01: number): void;
  setSfxVolume(v01: number): void;
  getMasterVolume(): number;        // 0..1
  setMuted(muted: boolean): void;
  isMuted(): boolean;

  playMusic(name: MusicName, opts?: { fade?: number, restart?: boolean }): void;
  stopMusic(fade?: number): void;
  get currentMusic(): MusicName | null;

  // 单次音效。opts: { position?: {x,y,z}, volume?: number, rate?: number, distance?: number }
  sfx(name: SfxName, opts?: object): void;

  // 连续循环（引擎/风）。每个 id 一路 voice。
  engineSet(id: string|number, params: {
    active: boolean,
    type?: 'prop' | 'jet' | 'turboprop' | 'car' | 'electric',
    rpm01?: number,        // 0..1
    throttle01?: number,   // 0..1
    position?: {x,y,z},
    listenerDistance?: number, // 若给出则用距离衰减
  }): void;
  windSet(gain01: number): void;    // 座舱/机体风噪，0..1
  setListener(pos: {x,y,z}, vel?: {x,y,z}): void;
  update(dt: number): void;         // 每帧调用
  dispose(): void;
}
export const audio = new AudioEngine();  // 单例

export type MusicName =
  | 'menu'        // 主菜单：温暖合成器 pad + 琶音
  | 'hangar'      // 机库：轻松 lo-fi
  | 'flight'      // 自由飞行：辽阔、缓慢
  | 'race'        // 竞速：快速 16 分音驱动
  | 'combat'      // 空战：紧张小调、打击乐
  | 'snow'        // 雪原：空灵钟声
  | 'desert'      // 沙漠：异域音阶
  | 'city'        // 城市：都市感
  | 'victory'     // 胜利短曲（一次性，播完自动回到之前的曲子）
  | 'failure';    // 失败短曲

export type SfxName =
  | 'click' | 'hover' | 'confirm' | 'cancel' | 'error'
  | 'explosion' | 'explosion_big' | 'crash' | 'gun' | 'cannon' | 'missile_launch'
  | 'lock' | 'beep' | 'stall_warn' | 'alarm' | 'pull_up'
  | 'gear' | 'touchdown' | 'squeal' | 'splash' | 'whoosh' | 'thud'
  | 'ring_pass' | 'collect' | 'parachute' | 'wind_gust' | 'engine_start' | 'engine_stop'
  | 'level_up' | 'money' | 'thruster';
```

要求：
1. **纯合成**，不得加载任何外部文件。允许使用 `OscillatorNode`/`AudioBufferSourceNode`(噪声)/`BiquadFilter`/`WaveShaper`/`ConvolverNode`(程序化脉冲响应做混响)/`PannerNode`/`StereoPanner`/`DynamicsCompressor`。
2. 引擎声：prop = 基频锯齿+方波（基频 ∝ rpm × 气缸脉冲）+ 带通噪声；jet = 高通+带通白噪声 + 低频 rumble，音高随 rpm。必须随 rpm/throttle 平滑变化（用 `setTargetAtTime`），无爆音。
3. 音乐：用 `music.js` 里的步伐调度器（lookahead ~0.1s, 每帧 `update()` 补音符）。每首曲子有：和弦进行、bass、pad、arp/lead、drum（noise hihat / kick sine 下扫 / snare noise）。**循环无缝**，`playMusic` 切换时交叉淡入淡出（默认 1.5s）。
4. `victory`/`failure` 是一次性 jingle，播完后自动 fade 回切之前那首（内部记录 previous）。
5. 所有 gain 路由：`source -> sfxGain/musicGain -> masterGain -> destination`；`setMuted` 用 masterGain 0。
6. 若 `AudioContext` 不可用或 init 失败，所有方法必须安全降级为 no-op，不得抛异常（用 try/catch 包裹）。
7. 不要在构造时创建 AudioContext（必须在 `init()`）。
8. 提供 `export function makeNoiseBuffer(ctx, seconds)` 之类的内部工具（不导出也可）。
9. 文件顶部写简短中文注释说明设计。

---

## B. `src/world/terrain.js`

```js
export const BIOMES = { /* biome 名 -> 调色板/参数默认值 */ };

export class Terrain {
  /**
   * @param {object} opts
   *   seed:number           默认 1337
   *   size:number           世界边长（米）默认 16000
   *   segments:number       网格分段（默认 320，须为偶数）
   *   biome:string          'green'|'snow'|'desert'|'rocky'|'city'|'tropical'
   *   seaLevel:number       默认 0
   *   heightScale:number    山峰高度上限，默认 900
   *   water:boolean         是否生成海面，默认 true
   *   waterColor:number     默认 0x2b6cb0
   *   flatRegions:[{x,z,radius,height,blend}]  跑道/城市用的平整区（blend 为过渡宽度，默认 radius*0.6）
   *   roughness:number      地形噪声粗糙度 0..1
   *   islands:boolean       是否做“岛群”遮罩（远离中心的区域沉入水下），默认 true
   *   roads:boolean         是否绘制道路纹理（默认 false，landmarks 负责实际道路）
   *   detail:number         附加细节噪声强度
   */
  constructor(opts?: object);

  /** 构建 mesh 并加入场景。返回 this。必须只用 THREE 内置几何/材质（可程序化 canvas 贴图）。 */
  build(scene: THREE.Scene): this;

  /** 世界坐标处的地形高度（米，ASL）。必须与渲染网格一致（同函数），并在网格顶点之间做双线性/重心插值或直接噪声采样。 */
  heightAt(x: number, z: number): number;

  /** 地表法线（单位向量），用于着陆判定/朝向。 */
  normalAt(x: number, z: number): THREE.Vector3;

  /** 该点是否为水面（heightAt < seaLevel）。 */
  isWater(x: number, z: number): boolean;

  /** 若点在 flatRegion 内返回该 region，否则 null。 */
  regionAt(x: number, z: number): object | null;

  /** 建议出生点：至少 3 个，含 'main'。heading 为跑道朝向（弧度，机头 -Z 约定：heading=0 表示朝 -Z）。 */
  get spawnPoints(): Array<{ name: string, position: THREE.Vector3, heading: number, runwayLength: number }>;

  /** 随机陆地点的工具函数（用于放树/建筑/收集物），返回 {x,y,z} 或 null。 */
  randomLandPoint(rng?: () => number): { x: number, y: number, z: number } | null;

  /** 每帧：水面波动（用 shader 或顶点动画）、可选云影。dt 秒。 */
  update(dt: number): void;

  /** 是否已 build。 */
  get built(): boolean;

  dispose(): void;
}
```

要求：
1. 高度函数必须是**确定性噪声**（自实现 value/simplex noise + fBm，禁止依赖外部包），`heightAt` 与网格顶点使用**同一个函数**，保证一致。
2. 岛屿遮罩：`dist = max(|x|,|z|)/(size/2)`，用 smoothstep 让边缘沉入水下达 -200m，形成远洋边界（视觉上像无尽海洋）。
3. 不同 biome 用不同调色板 + 坡度混色（陡坡露岩石/雪线）。用**顶点色**（`vertexColors: true`）+ 程序化噪声贴图（canvas 生成 256×256，repeat wrap）产生细节，避免纯色平淡。
4. 雪原 biome：高海拔全白、低海拔冰湖；沙漠：沙丘（用 ridged noise）、盐湖；city：基本平坦 + 少量丘陵；tropical：明亮绿+白沙海滩。
5. 水面：一个大的半透明平面（`size*3`），带轻微顶点波动 + 菲涅尔感（用 MeshStandardMaterial 低 roughness + 透明），水下可见性由地形高度决定。
6. 性能：地形网格 ≤ 400×400 顶点；使用 `BufferGeometry` + `computeVertexNormals()`；不得用 raycast 做 heightAt。
7. `spawnPoints`：优先落在 flatRegions 上（居中、朝 -Z 或 region 指定朝向），跑道长度取 region.radius*2。
8. 所有中文注释，代码整洁。

---

## C. `src/world/landmarks.js`

```js
export const LANDMARK_KITS = ['archipelago','skypark','snowstone','maywar','vetusta','raceway','naval','boneyard','stratos'];

export class Landmarks {
  /**
   * @param {Terrain} terrain
   * @param {object} opts
   *   kit: string            LANDMARK_KITS 之一（决定放置什么）
   *   seed: number
   *   density: number        0..1 控制树木/建筑数量（默认 0.6）
   *   water: boolean
   */
  constructor(terrain, opts?: object);

  /** 构建所有对象并加入 scene。返回 this。 */
  build(scene: THREE.Scene): this;

  /**
   * 碰撞体（世界坐标 AABB 或球）。物理模块每帧用它做飞机-世界碰撞。
   * @returns {Array<{
   *   id: string, kind: 'building'|'runway'|'hangar'|'tree'|'ship'|'carrier'|'tower'|'rock'|'ring'|'gate'|'prop'|'collectible',
   *   shape: 'box'|'sphere',
   *   center: THREE.Vector3, halfExtents?: THREE.Vector3, radius?: number,
   *   destructible: boolean, health: number, mass: number,
   *   static: boolean, object: THREE.Object3D
   * }>}
   */
  get colliders(): Array<object>;

  /** 竞速圆环（按顺序）。{index, position:THREE.Vector3, radius:number, object:THREE.Object3D, passed:boolean} */
  get raceRings(): Array<object>;

  /** 收集物（隐藏飞机/金币）。{id, name, position:THREE.Vector3, collected:boolean, object:THREE.Object3D, kind:'craft'|'coin'|'star'} */
  get collectibles(): Array<object>;

  /** 会对飞机开火的防御目标（可选）。{id, position, object, range, cooldown, health} */
  get turrets(): Array<object>;

  /** 任务锚点：{ cargo:[...], dropzones:[...], targets:[...], checkpoints:[...], landingPads:[...] } 每个元素 {id, name, position, radius} */
  get anchors(): object;

  /** 破坏一个碰撞体（生命归零时由游戏调用）；返回是否被摧毁。 */
  damage(collider: object, amount: number): boolean;

  /** 每帧：旋转雷达/风扇、船只浮动、被摧毁物体的残骸下落与火焰、圆环呼吸光。 */
  update(dt: number, time: number, camera?: THREE.Camera): void;

  /** 统计信息（UI 展示）：{ buildings, trees, roads, area } */
  get stats(): object;

  dispose(): void;
}
```

要求：
1. **全部程序化几何**（Box/Cylinder/Cone/Sphere/Torus/Lathe/Extrude 等组合），用 `InstancedMesh` 画树（数量可到 3000+，性能优先）与路灯/小道具。
2. 每个 kit 至少包含以下内容：
   - `archipelago`：2 个机场（沥青跑道+停机坪+机库+塔台+风向袋）、Vetusta 城市（网格街区 + 30+ 高楼，带窗户自发光）、树、道路（深灰条带 + 白虚线）、河流不需要（地形负责）、环岛、码头、桥梁、雷达站。
   - `skypark`：漂浮公园岛 + 白色城市塔群（SP1 Sky Park City 风格）+ 热气球 + 观景台。
   - `snowstone`：冰原、冰屋、雷达穹顶、失事飞机残骸、二战舰队（3 艘军舰：驱逐舰/巡洋舰/航母外形）。
   - `maywar`：沙漠小镇（土黄色平顶房）、绿洲、金字塔/遗迹、海盗船（带帆）、油井。
   - `vetusta`：纯城市地图：密集高楼、高架路、体育场、直升机坪（楼顶黄色 H）、霓虹招牌（自发光）。
   - `raceway`：地面赛道（闭环沥青 + 红白路缘 + 看台 + 起点龙门架）、空中竞速圆环 ×12、塔台。
   - `naval`：USS Tiny 航母（斜角甲板 + 舰岛 + 弹射器标记 + 拦阻索）、二战舰队、海盗船、灯塔、海上钻井平台、巨型海怪触手（Cthulhu，静态雕塑）。
   - `boneyard`：飞机坟场（50+ 废弃机体）、废料堆、起重机、铁丝网、集装箱迷宫。
   - `stratos`：高空浮空岛（多个悬浮岛 + 巨型飞艇 + 气球 + 云门），岛屿底部倒锥形岩石。
3. 城市建筑要**写实比例**（高楼 40~180m），带 window emissive 格纹贴图（canvas 程序化生成，多种色板）。
4. 圆环：`TorusGeometry`，自发光 + 半透明，双面；`raceRings` 顺序即飞行路线顺序（生成一条合理的环路）。
5. 收集物：小型隐藏飞机（用简单几何拼出的迷你机体）或发光星，位置分散在有挑战性的地方（山顶/桥下/楼顶/水下）。
6. 碰撞体数量控制在 **800 个以内**（树木合并为少数大碰撞体或不参与碰撞），保证物理循环性能。
7. 所有对象挂在 `this.root`（`THREE.Group`，name='landmarks'）下，方便整体卸载。

---

## D. `src/ui/widgets.js`

```js
/** 注入一次全局样式（若已注入则跳过）。 */
export function injectStyles(css?: string): void;
export const THEME: { /* 颜色/字体/间距常量 */ };

/** 轻量 DOM 构造器：el('div', {class:'x', onclick:fn, style:{}}, [children|string]) */
export function el(tag: string, props?: object, children?: Array<Node|string>): HTMLElement;
export function clear(node: HTMLElement): void;

export class Panel {      // 浮动面板，带标题栏/可拖动
  constructor(opts?: { title?: string, className?: string, draggable?: boolean, closable?: boolean });
  el: HTMLElement;               // 根元素
  body: HTMLElement;             // 内容容器
  setTitle(t: string): void;
  show(): void; hide(): void; toggle(): void;
  onClose?: () => void;
}

export class Slider {     // 带数值显示的滑条
  constructor(opts: { label: string, min: number, max: number, step?: number, value: number, format?: (v:number)=>string, onInput?: (v:number)=>void });
  el: HTMLElement; value: number; set(v: number): void;
}

export class Toggle {     // 开关
  constructor(opts: { label: string, value?: boolean, onChange?: (v:boolean)=>void });
  el: HTMLElement; value: boolean;
}

export class Button { constructor(opts:{label:string, onClick?:()=>void, kind?:'primary'|'ghost'|'danger', icon?:string}); el: HTMLElement; setEnabled(b:boolean):void; }

export class Select {     // 下拉
  constructor(opts:{label?:string, options:Array<{value:string,label:string}>, value?:string, onChange?:(v:string)=>void});
  el: HTMLElement; value: string;
}

export class Tabs {       // 标签页
  constructor(opts:{ tabs: Array<{id:string,label:string}>, onChange?:(id:string)=>void });
  el: HTMLElement; active: string; addTab(t:{id,label}):void;
}

export class ListBox {    // 可滚动列表（用于机型/地图/任务选择）
  constructor(opts:{ items:Array<{id:string,label:string,sub?:string,icon?:string}>, onChange?:(id:string)=>void, className?:string });
  el: HTMLElement; setItems(items:Array<object>): void; select(id:string): void; selected: string|null;
}

export class Toast {      // 屏幕顶部提示。静态方法
  static push(message: string, opts?: { kind?: 'info'|'warn'|'success'|'error', duration?: number }): void;
  static container: HTMLElement;
}

export class Modal {      // 模态对话框
  constructor(opts: { title: string, content: Node|string, buttons?: Array<{label:string,kind?:string,onClick?:()=>void,close?:boolean}> });
  open(): void; close(): void;
  root: HTMLElement;
}

export class Loading { static show(text?:string): void; static progress(p01:number, text?:string): void; static hide(): void; }
```

要求：
1. **纯 CSS 由 JS 注入**（`injectStyles`），风格：深色科技感 HUD，主色 `#00d0ff`，强调橙 `#ff9f43`，圆角 8px，毛玻璃 `backdrop-filter: blur(8px)`，字体 `system-ui, "Segoe UI", sans-serif`，禁止外部字体。
2. 所有控件必须支持键盘可达、`pointer-events` 正确、移动端不溢出。
3. 不得依赖 three.js。
4. 每个类都要有中文注释与 `// @ts-check` 友好的 JSDoc。

---

## 主程序使用的飞机状态对象（HUD/音频对接约定）

```js
/** @type {AircraftState} */
{
  callsign: string,
  position: THREE.Vector3, quaternion: THREE.Quaternion, velocity: THREE.Vector3,
  speed: number,            // m/s
  mach: number,             // 马赫
  altitudeASL: number, altitudeAGL: number, verticalSpeed: number,   // m/s
  heading: number, pitch: number, roll: number,     // 度
  throttle: number,         // 0..1
  rpm01: number,            // 0..1 发动机视觉/音频
  aoa: number,              // 弧度
  slip: number,             // 弧度
  gForce: number,
  stall: boolean, stalled: boolean,
  fuel01: number, health01: number,
  gearDown: boolean, gear01: number, flaps01: number, airbrake01: number,
  mass: number, thrust: number, lift: number, drag: number,
  engines: Array<{ id: string|number, type: string, rpm01: number, throttle01: number, position: THREE.Vector3, active: boolean }>,
  warnings: string[],
  crashed: boolean,
}
```
