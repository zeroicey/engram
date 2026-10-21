# 反复验证一个 gate，会把 goal 自己刷成 blocked

**Severity:** 🟠 medium · **Date:** 2026-10-21

## Symptom

刚建好的 goal，`rounds: 0`、`reports: 0`，`status` 却是 `blocked`：

```
status:  blocked
rounds:  0 (0 reports)
unchangedRounds = 11
blocked: no file change across consecutive rounds — needs human review (1x)
```

## Root cause

`onVerdict`（`goal check` 走的路径）把"本轮没有文件变化"计入 `unchangedRounds`：

```ts
const unchangedRounds =
  digest === null || (digest === released.lastDigest && released.lastDigest !== null)
    ? released.unchangedRounds + 1
    : 0;
```

`digest === null` 也算一轮 —— 这是**有意的**（文档写明：看不见工作树 = "无法确认进展"，
必须仍然有界，否则唯一最重要的一台机器上检测器被静默禁用）。

但一个正在**搭判据**的人会连续跑很多次 `goal check` 来验证证据是否成立，
每次都不改文件（改的是 `TASKS.md`，而它不在 digest 里）⇒ 计数一路涨过
`stuckRounds: 5` ⇒ 刚建的目标立刻判自己 blocked。

## Fix（操作层）

验证完把计数归零：`unchangedRounds = 0`、`lastDigest = null`、`blocker = null`。

## Guard

**搭判据阶段不要用 `goal check` 反复验证。** 要验证证据本身，
直接跑那条命令（`python3 deploy/check_oof_gate.py …`），它不触碰 goal 状态。
只在**确认一条证据应当通过**时调用一次 `goal check`。

## The generalisable rule

> 一个"检测停滞"的机制，会把**检测动作本身**当成停滞的证据。
> 任何有状态的健康检查，都要问：观察者自己的观测，会不会被计入被观测对象的信号？
