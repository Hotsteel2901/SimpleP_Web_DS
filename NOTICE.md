# 版权与许可声明 / Copyright & License Notice

## 本项目

SimplePlanes 2 · three.js 复刻版（SimpleP_Web_DS）
Copyright (C) 2026 Hotsteel2901

本程序是自由软件：你可以按照自由软件基金会发布的 **GNU Affero 通用公共许可证**
（**第 3 版或你选择的任何更新版本**）的条款重新发布和/或修改它。

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, **either version 3 of the License, or (at your option) any
later version**.

本程序发布时希望它有用，但不提供任何担保，甚至不提供适销性或特定用途适用性的默示担保。
详见 GNU Affero 通用公共许可证。

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

许可证全文见本仓库根目录的 [`LICENSE`](./LICENSE)（GNU AGPL-3.0 逐字副本），
或 <https://www.gnu.org/licenses/agpl-3.0.html>。

## 网络交互与源代码（AGPL 第 13 条）

本作品是一个可通过网络交互的网页应用。按照 AGPL 第 13 条，使用者有权获取其源代码：
作品界面（主菜单左下角）提供了指向本仓库的「源代码」链接，线上版本同样提供该入口。

## 第三方组件

- **three.js** — Copyright © 2010-2026 three.js authors，以 **MIT** 许可证发布。
  本仓库 `vendor/` 下存放其构建产物（`three.module.js`、`three.core.js`），
  以便在无打包器的环境下直接运行；它们仍归 three.js 作者所有并适用 MIT 条款。
  MIT 与 AGPL 兼容：MIT 部分不因此被改为 AGPL。
- **VibeHub SDK** — 由 gamesvibe.app 通过 `<script src="https://gamesvibe.app/sdk/v3/vibehub.js">`
  在运行时加载，不在本仓库内分发，适用其自身条款。

## 商标与免责

SimplePlanes 与 SimplePlanes 2 是 Jundroo, LLC 的商标。本项目是**非官方粉丝复刻**，
仅用于学习与演示，与 Jundroo 无任何隶属或背书关系，且**不包含任何原版素材**：
仓库中的每一个网格、贴图、音效与音乐都由 `src/` 下的代码在运行时程序化生成。
