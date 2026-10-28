// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * CJK 正文的排版预热。
 *
 * 正文使用 20MB 级的 Source Han Serif 可变字体。首次渲染一批新的中文字形时，
 * WebView 需要完成字形匹配与 shaping，实测一次可以占住主线程 500–800ms
 * （打开长会话、打开设置窗都会命中，且每个窗口各有一份独立的字形缓存）。
 *
 * 这里在空闲时段用同一字体渲染一段隐藏的常用字样本，把字形缓存提前填好，
 * 让用户真正看到内容时不再付这笔一次性成本。
 */

/** 常用汉字样本（覆盖日常对话与设置文案的高频字）。 */
const CJK_SAMPLE =
    '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活更别打女变神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功包片史委乎查轻易早曾除农找装广显阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨呀板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿兄迅套贸毕唯谷轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵硬麦蒋操耶阻订彩抽赞魔纷沿喊违妹浪汇币丰蓝殊献桌啦瓦莱援译夺汽烧距裁偏符勇触课敬哭懂墙袭召罚侠厅拜巧侧韩冒债曼融惯享戴童犹乘挂奖绍厚纵障讯涉彻刊丈爆乌役描洗玛患妙镜唱烦签仙彼弗症仿倾牌陷鸟轰咱菜闭奋庆撤泪茶疾缘播朗杜奶季丹狗尾仪偷奔珠虫驻孔宜艾桥淡翼恨繁寒伴叹旦愈潮粮缩罢聚径恰挑袋灰捕徐珍幕映裂泰隔启尖忠累炎暂估泛荒偿横拒瑞忆孤鼻闹羊呆厉衡胞零穷舍码赫婆魂灾洪腿胆津俗辩胸晓劲贫仁偶辑邦恢赖圈摸仰润堆碰艇稍迟辆废净凶署壁御奉旋冬矿抬蛋晨伏吹鸡倍糊秦盾杯租骑乏隆诊奴摄丧污渡旗甘耐凭扎抢绪粗肩梁幻菲皆碎宙叔岩荡综爬荷悉蒂返井壮薄悄扫敏碍殖详迪矛霍允幅撒剩凯颗骂赏液番箱贴漫酸郎腰舒眉忧浮辛恋餐吓挺励辞艘键伍峰尺昨黎辈贯侦滑券崇扰宪绕趋慈乔阅汗枝拖墨胁插箭腊粉泥氏彭拔骗凤慧媒佩愤扑龄驱惜豪掩兼跃尸肃帕驶堡届欣惠册储飘桑闲惨洁踪勃宾频仇磨递邪撞拟滚奏巡颜剂绩贡疯坡瞧截燃焦殿伪柳锁逼颇昏劝呈搜勤戒驾漂饮曹朵仔柔俩孟腐幼践籍牧凉牲佳娜浓芳稿竹腹跌逻垂遵脉貌柏狱猜怜惑陶兽帐饰贷昌叙躺钢沟寄扶铺';

interface FontWarmupWindow {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
}

let warmupScheduled = false;

/**
 * 用同一字体渲染一段隐藏的常用字样本，提前填充字形缓存。
 *
 * 元素使用 `visibility: hidden`：仍然参与布局（会触发字形匹配与 shaping），
 * 但不绘制，用户完全看不到。
 */
export function warmUpCjkGlyphs(fontFamily = 'var(--font-serif)'): void {
    if (typeof document === 'undefined' || !document.body) {
        if (import.meta.env.DEV) {
            console.warn('[glyph-warmup]', { stage: 'skipped-no-body' });
        }
        return;
    }

    const measure = (family: string): number => {
        const element = createWarmupElement(family);
        document.body.append(element);
        const startedAt = performance.now();
        // 强制布局，让字形匹配/ shaping 现在发生。
        void element.getBoundingClientRect();
        const elapsed = performance.now() - startedAt;
        element.remove();
        return Math.round(elapsed);
    };

    const customMs = measure(fontFamily);
    // DEV 下额外量一次系统字体：两者的差值就是「自定义 20MB 可变字体」的净成本。
    const systemMs = import.meta.env.DEV ? measure("Georgia, 'Times New Roman', serif") : 0;

    if (import.meta.env.DEV) {
        console.warn('[glyph-warmup]', { customMs, systemMs, chars: CJK_SAMPLE.length });
    }
}

function createWarmupElement(family: string): HTMLElement {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.dataset.touchaiGlyphWarmup = 'true';
    host.style.cssText = [
        'position:absolute',
        'left:-10000px',
        'top:0',
        'width:640px',
        'visibility:hidden',
        'pointer-events:none',
        'white-space:normal',
        'line-height:1.6',
        'font-size:16px',
        `font-family:${family}`,
    ].join(';');
    host.textContent = CJK_SAMPLE;
    return host;
}

/**
 * 在首屏后的空闲时段预热字形缓存（幂等）。
 *
 * 每个窗口（主窗口 / 设置窗 / popup）都有独立的字形缓存，所以各窗口都要跑一次。
 */
export function scheduleCjkGlyphWarmup(): void {
    if (warmupScheduled) {
        return;
    }

    warmupScheduled = true;
    if (import.meta.env.DEV) {
        console.warn('[glyph-warmup]', { stage: 'scheduled' });
    }

    const run = () => warmUpCjkGlyphs();
    const requestIdle = (globalThis as FontWarmupWindow).requestIdleCallback;

    if (typeof requestIdle === 'function') {
        requestIdle(run, { timeout: 2000 });
        return;
    }

    setTimeout(run, 800);
}
