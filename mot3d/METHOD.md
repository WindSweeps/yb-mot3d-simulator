# 174Yb 399 nm 三维 MOT：模型与验证

此模块独立于原两级 2D MOT 引擎。旧引擎的两段导向轴与纵向窗口不适用于这里的六束光和三维磁场；原引擎、五比例结果保持原文件。新模块用于比较失谐、各束功率、电流与入射束条件对单批原子轨迹的影响。

## 几何、参数与来源

坐标取冷束向 +X、Z 竖直向上、水平 MOT 光轴沿 Y。把用户指定的两组斜光在竖直平面内对称、入射方向夹角120°表示为 k₁=(√3/2,0,1/2)、k₂=(−√3/2,0,1/2)。六束顺序为 +V1、−V1、+V2、−V2、+H、−H；用户的 Gaussian waist 6 mm 按通常的 **1/e² 光强半径**实现。注入面 x=−30 mm、每束15 mW、−25 MHz失谐等为可调示例初值。2026-10-30按用户决定，纵向母高斯改为 μ=40 m/s、σ=14.7 m/s，来自Höhn所引AOSense厂家模拟，替代旧20/4 m/s示例。仅抽取正向速度；截断后的理论均值40.145 m/s、标准差14.500 m/s，页面另显示实际批次的抽样均值和标准差。

用户确认主线圈轴沿水平 MOT 光轴 Y，故默认 B=b(−x/2,y,−z/2)+B_bias。另可切换 Z 主轴作为对照，B=b(−x/2,−y/2,z)+B_bias；两种配置均满足 ∇·B=0。b=主线圈电流×梯度系数，三路偏置场各自为电流×场系数。1 G/cm=0.01 T/m，1 G=10⁻⁴ T。当前 10 G·cm⁻¹·A⁻¹ 与 1 G/A 是界面换算初值，需以实际线圈标定替换。磁零点按此线性场解析求解。

圆偏振的 helicity 定义为光子角动量沿其自身传播方向的符号；模型取V1/V2两束对均为−1，水平对为+1。此理想偏振与用户指定的 Y 主轴产生三维恢复力，实际偏振纯度尚未输入。切换主轴或反转电流时保持光偏振不变，因而可出现失稳。给定两竖直轴与 Z 都成60°；对称同旋向时，它们在 X、Z 的偏振张量对角元同号，而 Z 主轴四极场的 X、Z 梯度异号，不能同时给两方向恢复力。

以 174Yb 为模型基准，采用 ¹S₀→¹P₁（J=0→1）跃迁，λ=399 nm，Γ/2π=29.13 MHz，g_J=1（LS耦合近似）。实际实验同位素尚未提供。质量为173.93886755 u；I_sat=πhcΓ/(3λ³)，约60 mW/cm²。Γ 为角频率线宽，界面 MHz 失谐转换为 Δ=2πδ。常数来源见下方参考。

## 光力和随机轨迹

每束光取穿过原点的准直高斯束，s_j=2P_j exp(−2r⊥²/w²)/(πw² I_sat)。局部量子化轴沿完整 B 向量；c_j=k̂_j·B̂，h_j 为该束 helicity，三个分量的权重为 w₊=(1+h_j c_j)²/4，w₀=(1−c_j²)/2，w₋=(1−h_j c_j)²/4。

采用 PyLCP §2.3、式(35)的 J=0→1 启发式共享饱和形式：

\[
R_{jq}=\frac{\Gamma}{2}\frac{s_jw_{jq}}{1+\sum_l s_l+4(\Delta-\mathbf k_j\cdot\mathbf v-q\mu_B|\mathbf B|/\hbar)^2/\Gamma^2},\quad
\mathbf a_{\rm opt}=\frac{\hbar k}{m}\sum_{j,q}R_{jq}\hat{\mathbf k}_j.
\]

动力学加入−gẑ。轨迹用显式中点法处理确定性漂移，每步叠加高斯反冲扩散，其速度增量协方差为

\[
\operatorname{Cov}(\delta\mathbf v)=v_r^2\,dt\left[\sum_j R_j\hat{\mathbf k}_j\hat{\mathbf k}_j^T+\frac{\sum_jR_j}{3}\mathbf I\right].
\]

第一项是吸收散粒噪声，第二项是各向同性自发辐射近似；非正交光轴的相关噪声保留。反冲以连续速度扩散处理，原子之间不相互作用。共享饱和近似在高速度、大失谐分量共存时可能低估力，因此捕获边界随此近似而变化；本模块不包括相干驻波、再吸收、碰撞或漏能级损失。

初始原子是同一时刻入射的一批：Y/Z位置各取指定RMS宽度的高斯分布，纵速取非负截断正态，横向热速度每分量标准差√(k_BT/m)。随机种子固定，可重放；初始样本与各原子的反冲流分开。默认192原子、20 ms、5 μs步长，120帧。半径150 mm之外终止计算并标记越界，这不是装置孔径。

**留存**定义为最后5 ms内每一积分采样均满足相对光束交点 r<3 mm 且 |v|<1 m/s；若计算总长不足5 ms则检查整个时段。此集合的云中心是末态位置均值，rmsMM是围绕该质心的逐轴标准差，平均速度是平均|v|。`allMeanSpeed`另统计仍在计算域内的原子。无留存时三种留存统计为null。判据以光束交点为中心，不随偏置场零点移动。

## 验证方法

下列容差在对应计算前设定。

1. 无光无重力力严格为零；有重力轨迹与解析抛体解误差 <10⁻¹⁰ m、<10⁻⁹ m/s。
2. 平衡光在原点的力 <10⁻⁹ m/s²；默认场在每轴±0.1 mm产生恢复力，在±0.1 m/s产生阻尼。反转电流应被同一恢复力检查拒绝，蓝失谐应反阻尼。
3. 偏置场零点用独立代数值核对；单束零磁场散射率用标量两能级公式核对，相对误差 <10⁻¹²。光轴单位长度和120°夹角直接检查。
4. 同种子逐位复现；无光时打开反冲不改变轨迹。不同种子改变样本。空留存和越界均保留明确状态。
5. 先测8原子小规模耗时，再运行192原子默认批次。相同初始样本、关闭反冲时将5 μs减至2.5 μs，在2 ms捕获瞬态检查末态位置和输出帧位置RMS差<0.02 mm、速度RMS差<0.02 m/s。随机批次的步长变化另以计数的抽样尺度比较，不用轨迹逐点一致作为要求。
6. 低速度无磁场molasses用独立线性化摩擦与扩散公式计算三维平衡速度方差。512个从静止开始的原子运行8 ms，各轴方差与该解析近似差<22%（有限样本、有限速度与步长共同影响）。该检查可检出丢失吸收反冲或把非正交方向当成笛卡尔轴的噪声实现错误。

解析抛体、单束率与零点是独立已知答案；恢复/阻尼是物理符号控制。步长减半共享同一力函数，只验证积分的一致性。线圈系数与光场分布仍需要实验标定。

## 2026-10-29 验证结果（旧20/4 m/s输入）

`node mot3d/physics.test.mjs`共19项检查通过。旧2D引擎另运行无光、无重力控制，所得加速度为零；它只用于核对旧模块仍可调用，三维模块的物理检查使用以上独立答案。

| 检查 | 结果 |
|---|---|
| 8原子、20 ms先导运行 | 约65 ms墙钟时间 |
| 192原子、20 ms默认运行 | 约1.19 s墙钟时间 |
| 确定性瞬态，5→2.5 μs | 末态位置RMS差0.000051 mm，速度RMS差0.000032 m/s；输出帧位置RMS差0.000037 mm |
| 512原子molasses速度方差 | X/Y/Z相对解析近似误差−2.1%、+11.1%、−5.8% |
| 默认随机批次，5 μs | 留存98/192原子；留存平均速度0.384 m/s |
| 同参数，2.5 μs | 留存85/192原子；留存平均速度0.420 m/s |

默认5 μs结果的留存质心为(0.0051,−0.0054,−0.0020) mm，逐轴RMS宽度为(0.0730,0.0819,0.1898) mm。留存比例为51.0%，2.5 μs结果为44.3%；步长改变后反冲抽样序列也改变，两比例差6.8个百分点，小于本次两倍合并二项抽样标准差加3个百分点的检查容差13.2个百分点。192原子足以观察调参趋势，精确比较几百分点的差异需要增加样本或多种子重复。耗时为本机Node运行结果，浏览器与机器负载会影响实际等待时间。

## API

`physics.js` 导出 `DEFAULTS`、`BEAM_DIRECTIONS`、`BEAM_LABELS`、`HELICITIES`、`CONSTANTS`、`derive(params)`、`compile(params)`、`fieldAt(position, paramsOrCompiled)`、`opticalAcceleration(position,velocity,paramsOrCompiled)`、`acceleration(...)`、`radiation(...)`、`simulate(params,options)`。位置/速度/场分别为m、m/s、T；`radiation`给光加速度与六束散射率。`acceleration`另含重力。`derive.mainTensor`为主梯度乘数的对角三元组。

结果：`frames`为120×n×3 Float32Array，位置单位m；`frameAlive`为120×n Uint8Array；`times`为秒；末态使用`finalPositions`、`finalVelocities`、`alive`、`retained`。`summary`含`retained`、`retainedFraction`、`centroidMM`、`rmsMM`、`meanSpeed`、`allMeanSpeed`、`validCount`、`zeroMM`、`criterion`、`elapsedMS`。测试可用`options.initialStates`传入n×6扁平SI数组、`options.frameCount`改变输出帧数。Worker接收`{id,params}`，返回`{id,result}`并转移数组；失败返回`{id,error}`，取消通过terminate完成。

## 参考

- S. Eckel, D. S. Barker, E. B. Norrgard, J. Scherschligt, *PyLCP: A Python package for computing laser cooling physics*, §2.3式(35)、§3.2–3.3。已核对[作者/NIST全文](https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=931233)。该文给出旋转偏振、共享饱和力及其适用范围；这里以JS重新实现并采用上述高斯扩散。
- *Cryogenic buffer gas beams of AlF, CaF, MgF, YbF, Al, Ca, Yb and NO – a comparison*, §3.3，给出Yb399 nm、Γ/2π=29.13 MHz。[期刊原文](https://doi.org/10.1080/00268976.2022.2146541)。
- [CIAAW：Ytterbium同位素质量](https://ciaaw.org/ytterbium.htm)，174Yb质量173.93886755 u。
- [NIST / CODATA 2022基本常数](https://pml.nist.gov/cuu/pdf/wall_2022.pdf)，h、k_B、c、μ_B、u。

实现与验证日期：2026-10-29。

## 2026-10-30：冷束、偏振与电流核查

当前结果与可复跑脚本见[重算报告](reports/2026-10-30-source-polarization/REPORT.md)、[计算前检查](reports/2026-10-30-source-polarization/GATE.md)和[原始统计](reports/2026-10-30-source-polarization/results.json)。本轮增加4项检查，共23项通过；网页默认192原子得到39个留存（20.3%），4个种子合计4096原子得到833个留存（20.34%），2.5 μs步长得到20.68%。旧记录的98/192属于旧20/4 m/s输入。

新增API `sampleInitialStates(params)` 返回初始相空间；结果 `initialLongitudinalVelocities` 保存每个原子的入口速度在源轴上的投影。`summary.initialLongitudinal` 与 `summary.retainedInitialLongitudinal` 分别统计全部入射样本、最终留存样本的**入口**纵速，字段为 `{n,meanMS,stdMS}`，stdMS使用总体分母n；与终态 `meanSpeed=mean(|v|)` 分开。无留存时对应入口均值/标准差为null。

### 能级、偏振和斜光几何

¹⁷⁴Yb基态¹S₀有J=0、m=0；激发态¹P₁有J=1、m=−1,0,+1。取gJ=1的LS近似，固定+Y量子轴时 `ΔE_m=gJ μB m B_y`。网页图画零bias的Y轴截面、正梯度b；它说明标准设置，不随所有参数动态绘制完整光谱。在y>0、B_y>0处，m=−1支路下降，更接近红失谐光，所需恢复束沿−Y且驱动Δm=−1。y<0时恢复束沿+Y且驱动Δm=+1。因此两束H相对**各自k**的h都是+1。工程中的左/右旋必须先声明观察方向。

V1/V2处于径向平面，梯度与主轴反号，四束取h=−1。对当前120°几何，在原点低场线性化有 `Σ_j h_j k̂_j k̂_jᵀ=diag(−3,2,−1)`；乘主场梯度 `b diag(−1/2,1,−1/2)` 得 `b diag(3/2,2,1/2)`。红失谐使总系数为负，所以三轴均恢复，刚度比例X:Y:Z=3:4:1。独立解析张量与有限差分比较通过；这组现有h无需反转。改为Z主轴或负主电流时光偏振固定，可能反陷。

### 电流方向定义

主圈位于y=±a。同一观察者从+Y朝原点看，正I定义为+y圈逆时针、−y圈顺时针。两圆线圈的轴向场为

\[
B_y(y)=\frac{\mu_0NIR^2}{2}\left[(R^2+(y-a)^2)^{-3/2}-(R^2+(y+a)^2)^{-3/2}\right],\quad
b=\left.\frac{\partial B_y}{\partial y}\right|_0=\frac{3\mu_0NIR^2a}{(R^2+a^2)^{5/2}}>0.
\]

这是从Biot–Savart公式得到的软件正电流约定。偏置线圈取同向电流：从对应正轴朝原点看，两圈逆时针对应正轴场。3D箭头随输入电流反向，零电流隐藏；实际场仍用标定系数和线性四极场计算，不由示意环尺寸反算。实际电源正负端与绕组的映射、G/cm/A和G/A仍需实测。

### 本轮原文定位

- Höhn, *State-dependent potentials and clock ground-state cooling in an ytterbium quantum simulator*, 2024，[官方PDF §2.5.1，印刷75／PDF85](https://edoc.ub.uni-muenchen.de/34662/1/Hoehn_Tim.pdf#page=85)：40 m/s纵向均值与14.7 m/s标准差，注明“as simulated by the manufacturer”。参考面是2D MOT输出，后续差分管传输另外建模；本模块将其作为入射参考，不含上游孔管的再次速度选择。
- AOSense，[2023产品资料p2](https://aosense.com/wp-content/uploads/2023/05/AOSense-Cold-Atomic-Beam-System-2023.pdf#page=2)：标称“Axial speed ~40 m/s”；未给分布宽度。
- [NIST Yb I能级表](https://physics.nist.gov/PhysRefData/Handbook/Tables/ytterbiumtable5.htm)：¹S₀ J=0与¹P₁ J=1；Lauprêtre等，[OSA Continuum 3,50–57(2020)，作者稿PDF p2 §2、p3 §3.1](https://arxiv.org/pdf/1912.08065#page=2)，给出399 nm跃迁及174Yb光谱测量。
- M. R. Tarbutt, *Magneto-optical trapping forces for atoms and molecules with complex level structures*, New J. Phys.17,015007(2015)，[作者稿v2 PDF pp3–6](https://arxiv.org/pdf/1409.0244#page=4)，Eq.(2)、Zeeman位移与相对自身k的偏振旋转、吸收σ±对应ΔM=±1。本文用它核定物理选择定则；未把PyLCP不同语境的σ标签直接当本代码Δm标签。
- Anwar、Faisal与Ahmed，Eur. Phys. J. D67,270(2013)，[DOI](https://doi.org/10.1140/epjd/e2013-40510-x)，[作者全文](https://www.researchgate.net/publication/263311332_An_experimental_investigation_of_the_trap-dynamics_of_a_cesium_magneto-optical_trap_at_high_laser_intensities) PDF p2 §2：反亥姆霍兹两圈“equal and opposite currents”。本文只借用线圈配置说明，不移植Cs参数；具体顺逆时针由上式推导。
