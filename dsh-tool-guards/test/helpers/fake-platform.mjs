/**
 * 测试辅助：在目标模块求值**之前**把 `process.platform` 换成 `FAKE_PLATFORM`。
 *
 * 为什么需要它：`oracle/helpers/python-cmd-guard.mjs` 在模块顶层就做了
 * `const isWindows = process.platform === 'win32'`，Windows 开发机上 Unix 分支
 * 永远跑不到，那段移植代码因此长期没有真值背书（只靠读代码"看起来一样"）。
 * `node --import` 保证本文件先于主模块执行，改写后原脚本会**真的**走 Unix 分支，
 * 于是可以拿它当 oracle 逐字对拍。
 */
const target = process.env.FAKE_PLATFORM
if (target) {
  Object.defineProperty(process, 'platform', { value: target, configurable: true })
}
