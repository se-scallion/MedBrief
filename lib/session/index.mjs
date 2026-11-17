// 会话依赖唯一接缝（q1 裁定 B）：换依赖只改这一行。
// 装法：npm i --prefix vendor（根 node_modules 是 MedData 软链，永久禁止在根 npm i）。
export * from '../../vendor/node_modules/iron-session/dist/index.js'
