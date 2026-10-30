# Yb 399 nm 3D MOT 调参工作台

[打开公开网页](https://windsweeps.github.io/yb-mot3d-simulator/mot3d/)

浏览器内运行的轻量三维 MOT 模拟器：调节六束 Gaussian 光的功率、失谐、waist、主线圈和三轴偏置，查看原子轨迹、磁场线、光力、云团密度及 A/B 参数比较。

采用 174Yb 399 nm 的半经典散射力、Doppler/Zeeman 位移、重力和随机光子反冲。默认 waist 为 6 mm，冷束纵速的母高斯参数为 μ=40 m/s、σ=14.7 m/s，仅抽取正向速度。主四极场轴与水平 MOT 光轴同向，网页包含圆偏振、电流方向及能级依据。线圈换算系数为可编辑示例。

- [模型、参数来源与参考文献](mot3d/METHOD.md)
- [40 m/s 冷束捕获重算报告](mot3d/reports/2026-10-30-source-polarization/REPORT.md)
- [复算原始统计](mot3d/reports/2026-10-30-source-polarization/results.json)

## 本地运行

在仓库根目录运行：

```sh
python3 -m http.server 4174 --bind 127.0.0.1
```

打开 <http://127.0.0.1:4174/mot3d/>。无构建步骤；Three.js 与 OrbitControls 随仓库提供。模块 Worker 需通过 HTTP/HTTPS 加载。参数保存于当前浏览器，计算在本机完成。

## 数值检查与复算

使用支持 JavaScript ES 模块的 Node.js（建议 22 或更新版本）：

```sh
node mot3d/physics.test.mjs
node mot3d/reports/2026-10-30-source-polarization/run.mjs
```

23 项检查覆盖解析抛体、散射力、恢复/阻尼符号、非零磁场选择定则、入口抽样、反冲方差与步长收敛。默认交互批次为 192 原子；正式报告使用多种子批次。留存按最后 5 ms 持续满足距光束交点小于 3 mm、速率小于 1 m/s 统计。

## 发布与依赖

GitHub Pages 从 `main` 分支根目录发布；根入口自动进入 `mot3d/`。运行模块保持相对路径，可部署在子目录中。

`anatomy-demo/vendor/` 仅保存渲染库；Three.js r160 与 OrbitControls 使用 MIT 许可，见 [来源](anatomy-demo/vendor/README.md) 和 [许可证](anatomy-demo/vendor/THREE-LICENSE.txt)。

2026-10-30：首次公开发布当前 3D MOT 模块及其可复算说明。
