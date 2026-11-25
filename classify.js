'use strict';
/**
 * 桌面快捷方式分类器（纯规则）
 *
 * 设计原则：这里不允许出现任何"某台特定电脑"的信息 ——
 * 没有用户名、没有盘符、没有个人软件名。只放通用事实：
 * Steam 协议长什么样、哪些公司是游戏发行商、Windows 标准安装位置在哪。
 *
 * 三类结果 + 两个特殊值：
 *   game    游戏
 *   tool    日常工具
 *   niche   小众软件
 *   folder  指向文件夹的快捷方式（不参与分类）
 *   unknown 判不出来，交给用户点一次
 */

// ── 通用事实：游戏平台的 URL 协议（全世界任何 Windows 都一样）
const GAME_URL_SCHEMES = [
  'steam://', 'com.epicgames.launcher://', 'battlenet://', 'uplay://', 'origin://',
  'goggalaxy://', 'xbox:', 'roblox://', 'wegame://', 'ea://', 'com.mihoyo',
  'hyp://', 'tap://', 'tencent://launch', 'gameloop://', 'nvidia://'
];

// ── 通用事实：主流平台的游戏安装目录结构
const GAME_PATH_HINTS = [
  '\\steamapps\\common\\', '\\steamapps\\', '\\epic games\\', '\\wegameapps\\',
  // Steam 的「非 Steam 游戏」图标一律落在 <Steam>\steam\games\<sha1>.ico。
  // 这是平台自己的约定，跟装了什么游戏无关，所以拿它当信号不会认错。
  '\\steam\\games\\',
  '\\riot games\\', '\\gog games\\', '\\gog galaxy\\', '\\ubisoft game launcher\\',
  '\\blizzard entertainment\\', '\\battle.net\\', '\\paradox interactive\\',
  '\\electronic arts\\', '\\ea games\\', '\\rockstar games\\', '\\steam\\steam.exe'
];

// ── 通用事实：游戏发行商 / 平台（公司名字段里出现即认定）
const GAME_PUBLISHERS = [
  'blizzard', 'ubisoft', 'electronic arts', 'ea games', 'rockstar', 'valve',
  'paradox', 'riot games', 'cd projekt', 'bethesda', 'square enix', 'capcom',
  'bandai', 'sega', 'konami', 'koei', 'activision', 'take-two', '2k games',
  'epic games', 'gog.com', 'mihoyo', 'hoyoverse', 'miHoYo'.toLowerCase(),
  '完美世界', '盛趣', '巨人网络', '网易游戏', '腾讯游戏', '多益网络', '西山居',
  '莉莉丝', '鹰角', '库洛', '雷霆游戏', '三七互娱', '凤侠', '浩方', '游侠',
  '盛大', '九城', '网龙', '光宇', '搜狐畅游', '金山游戏', '蜗牛'
];

// ── 通用事实：大型软件厂商（装在系统目录、有正规签名的）
const TOOL_PUBLISHERS = [
  'microsoft', 'adobe', 'google', 'tencent', 'alibaba', 'bytedance', 'baidu',
  'netease', 'thunder', '迅雷', '金山', 'kingsoft', 'wps', '360', 'qihoo',
  'unity', 'blender', 'jetbrains', 'autodesk', 'corel', 'sublime', 'github',
  'mozilla', 'opera', 'apple', 'oracle', 'vmware', 'cisco', 'nvidia', 'intel',
  'realtek', 'logitech', 'razer', 'corsair', 'steelseries', 'deepseek',
  'anthropic', 'openai', 'zoom', 'slack', 'dropbox', 'evernote', 'notion',
  'obsidian', 'typora', 'sogou', '搜狗', 'iqiyi', '爱奇艺', 'bilibili', '哔哩哔哩'
];

// ── 名称关键词（对"目标已失效"或"读不到公司名"的兜底）
const GAME_NAME_WORDS = [
  '游戏', '对战平台', '电竞', '街机', '模拟器', '联机', '开黑', '加速器',
  '助手', '盒子', 'launcher', 'game', 'play', 'gaming', 'gm', 'kawaks',
  'dnf', 'cf', 'lol', 'dota', 'csgo', 'cs2', 'mc', 'minecraft', 'steam'
];

/**
 * 强游戏词：命中即判游戏，优先级高于厂商判断。
 * 用途：解决"腾讯/网易既做工具又做游戏"的双重身份问题 ——
 * WeGame 的产品名含 wegame，就该归游戏，而不是被 tencent 抢到工具里。
 */
const STRONG_GAME_WORDS = [
  'wegame', '我的世界', 'minecraft', '原神', '崩坏', '星穹铁道', '明日方舟',
  '和平精英', '王者荣耀', '地下城', '穿越火线', '英雄联盟', '魔兽', '星际争霸',
  '暗黑破坏神', '守望先锋', '炉石', '战网', 'battle.net', 'steam', 'epic games',
  'rockstar', 'uplay', 'origin', 'gog galaxy', '游戏中心', '游戏盒子',
  'path of exile', '流放之路', 'poe2', 'poe'
];

const TOOL_NAME_WORDS = [
  '浏览器', 'browser', '播放器', 'player', '网盘', '云盘', '下载', '连点',
  '录屏', '截图', '转换器', '编辑器', '解压', '压缩', '清理', '管家', '安全',
  '输入法', 'office', 'word', 'excel', 'ppt', 'pdf', 'vpn', '代理', 'ssh',
  'sftp', 'editor', 'code', 'ide', 'studio', 'hub', 'tool', 'dev-c', 'devcpp',
  // 通用开发/专业工具：这些名字在任何 Windows 上都指同一个东西
  'pycharm', 'intellij', 'webstorm', 'goland', 'clion', 'rider', 'datagrip',
  'jetbrains', 'vscode', 'visual studio', 'sublime', 'eclipse', 'git bash',
  'postman', 'navicat', 'dbeaver', 'xshell', 'securecrt', 'filezilla', 'putty',
  'anaconda', 'jupyter', 'matlab', 'zbrush', 'maya', 'cinema 4d', '3ds max',
  'sketchup', 'blender', 'unity'
];

// ── 记忆表的键：优先用目标程序路径（同一程序不管快捷方式叫什么名都能命中）
function memoryKey(info) {
  const t = (info.target || '').trim().toLowerCase();
  if (t) return 'p:' + t;
  const u = (info.url || '').trim().toLowerCase();
  if (u) return 'u:' + u;
  return 'n:' + (info.name || '').toLowerCase();
}

/**
 * 在 text 里找 list 中任意一个词。
 * 短英文词必须独立成词 —— 否则 "tim"（QQ 的 TIM）会命中 Runt**im**e，
 * "unity" 会命中 comm**unity**，整批运行库会被错判成日常软件。
 */
function has(text, list) {
  const s = String(text || '').toLowerCase();
  for (const w of list) {
    const k = String(w).toLowerCase();
    if (/^[a-z0-9][a-z0-9 .+-]{0,5}$/.test(k)) {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)').test(s)) return w;
    } else if (s.includes(k)) {
      return w;
    }
  }
  return null;
}

/**
 * @param {object} info  { name, ext, target, url, company, product, exists, isDir }
 * @param {object} [memory] 用户记忆表 { 'p:c:\\xxx.exe': 'game' }
 * @returns {{category:string, reason:string, source:string, key:string}}
 */
function classifyShortcut(info, memory) {
  const key = memoryKey(info);

  // 0) 用户改过的，永远优先 —— 这是唯一"个性化"的部分
  if (memory && memory[key]) {
    return { category: memory[key], reason: '按你上次的选择', source: 'memory', key };
  }

  const name = String(info.name || '').toLowerCase();
  const target = String(info.target || '').toLowerCase();
  // 快捷方式名 + 目标程序路径一起看：很多程序名字只出现在路径里
  const nameAndPath = name + ' ' + target;
  const url = String(info.url || '').toLowerCase();
  const pub = `${info.company || ''} ${info.product || ''}`.toLowerCase();

  // 1) 指向文件夹的快捷方式 —— 不是程序，不参与游戏/工具分类
  if (info.isDir) {
    return { category: 'folder', reason: '这是文件夹入口，不是程序', source: 'rule', key };
  }

  // 2) URL 协议：最强的信号，任何电脑上都一样
  if (url) {
    const s = has(url, GAME_URL_SCHEMES);
    if (s) return { category: 'game', reason: `启动协议 ${s.replace(/[:/]+$/, '')}`, source: 'rule', key };
    if (/^https?:\/\//.test(url)) {
      return { category: 'tool', reason: '普通网页书签', source: 'rule', key };
    }
  }

  // 3) 目标程序已不存在（断链）—— 只能靠名字猜，猜不出就问
  if (!info.exists && target) {
    const g = has(name, GAME_NAME_WORDS);
    if (g) return { category: 'game', reason: `目标已失效，名称含「${g}」`, source: 'guess', key };
    const t = has(nameAndPath, TOOL_NAME_WORDS);
    if (t) return { category: 'tool', reason: `目标已失效，名称含「${t}」`, source: 'guess', key };
    return { category: 'niche', reason: '目标程序已不存在，先归到小众（可拖到别的框）', source: 'guess', key };
  }

  if (!target && !url) {
    const g = has(name, GAME_NAME_WORDS);
    if (g) return { category: 'game', reason: `名称含「${g}」`, source: 'guess', key };
    const t = has(name, TOOL_NAME_WORDS);
    if (t) return { category: 'tool', reason: `名称含「${t}」`, source: 'guess', key };
    return { category: 'niche', reason: '读不到目标，先归到小众（可拖到别的框）', source: 'guess', key };
  }

  // 4) 路径硬信号
  const gp = has(target, GAME_PATH_HINTS);
  if (gp) return { category: 'game', reason: `安装在游戏目录 ${gp}`, source: 'rule', key };

  // 4.5) 强游戏词放在厂商之前 —— 否则 WeGame 会被「Tencent」抢去当日常工具
  const strong = has(name, STRONG_GAME_WORDS) || has(info.product, STRONG_GAME_WORDS);
  if (strong) return { category: 'game', reason: `产品/名称是游戏「${strong}」`, source: 'rule', key };

  // 5) 发行商
  const gpub = has(pub, GAME_PUBLISHERS);
  if (gpub) return { category: 'game', reason: `发行商「${gpub}」`, source: 'rule', key };

  const tpub = has(pub, TOOL_PUBLISHERS);
  if (tpub) return { category: 'tool', reason: `知名厂商「${tpub}」`, source: 'rule', key };

  // 6) 系统级安装目录（Program Files）通常是正规软件
  if (target.includes('\\program files')) {
    return { category: 'tool', reason: '安装在 Program Files', source: 'rule', key };
  }

  // 7) 用户级 / 便携安装 —— 小工具、个人作品的典型特征
  if (target.includes('\\appdata\\local\\') || target.includes('\\appdata\\roaming\\')) {
    return { category: 'niche', reason: '用户级安装，不写系统目录', source: 'rule', key };
  }

  // 8) 有公司名但不是知名厂商 —— 这就是"小众软件"的定义
  if (info.company) {
    return { category: 'niche', reason: `非知名厂商「${info.company.slice(0, 24)}」`, source: 'rule', key };
  }

  // 9) 名称兜底
  const g2 = has(name, GAME_NAME_WORDS);
  if (g2) return { category: 'game', reason: `名称含「${g2}」`, source: 'guess', key };
  const t2 = has(nameAndPath, TOOL_NAME_WORDS);
  if (t2) return { category: 'tool', reason: `名称/路径含「${t2}」`, source: 'guess', key };

  // 10) 实在判不出：先归到「小众」，保证它也会被一起排好，
  //     而不是留一张孤零零的图标在桌面中间。拖一次就记住了。
  return { category: 'niche', reason: '没有明显特征，先归到小众（可拖到别的框）', source: 'guess', key };
}

/* ============================================================
 * 二、已安装软件分类（注册表条目 → 类别）
 *
 * 和快捷方式分类不同，这里面对的是「控制面板里那一长串」，
 * 里面有大量根本不是给人用的条目：运行库、SDK 组件、驱动、补丁。
 * 判断错了代价很大 —— 卸掉 VC++ 运行库会让一堆软件打不开。
 *
 * 所以顺序很讲究：先排除「不能碰的」，再分「能碰的」。
 * ============================================================ */

/** 依赖库 / 运行时：卸了会让别的软件打不开 */
const RUNTIME_RULES = [
  { re: /visual c\+\+.*(redistributable|runtime|-)/i, why: 'C++ 运行库' },
  { re: /redistributable/i, why: '运行库' },
  { re: /(^|\s)vc\+\+ ?(20\d\d|\d+)/i, why: 'C++ 运行库' },
  { re: /\.net\b.*(runtime|framework|sdk|host|apphost|targeting pack|templates?|workload|manifest|asp\.net|tools)/i, why: '.NET 运行时' },
  { re: /^microsoft \.net/i, why: '.NET 组件' },
  { re: /directx|d3d|dxsetup/i, why: 'DirectX' },
  { re: /xna framework|slimdx|openal|physx|mono\b|json\.net/i, why: '图形/游戏运行库' },
  { re: /prerequisites?|prereq|redist/i, why: '预装运行库' },
  { re: /(java|jre|jdk)\b.*(runtime|update|se\b|environment)/i, why: 'Java 运行时' },
  { re: /silverlight|adobe flash/i, why: '旧版网页插件' },
  { re: /codec pack|编解码|解码器包/i, why: '编解码器包' },
  { re: /universal crt|webview2/i, why: '系统运行组件' },
  { re: /\bruntime\b/i, why: '运行时' },
  { re: /windows sdk|software development kit|sdk addon|driver kit|wdk|windbg|debugging tools|certification kit/i, why: '开发 SDK' },
  { re: /standard library|core interpreter|executables \(|pip bootstrap|test suite|tcl\/tk support|development libraries|(utility scripts|symbols)/i, why: '运行时组件' },
  { re: /update health|update for |hotfix|security update|^kb\d{6}/i, why: '系统更新' },
  { re: /运行库|运行环境|运行组件|依赖库|组件包/i, why: '运行库' }
];

/**
 * 大软件（尤其 Visual Studio / Office / SDK）会把自己拆成几十个条目挂进注册表：
 * 语言包、模板、契约、Intellisense 缓存…… 这些都是碎片，单卸一个毫无意义，
 * 还容易把宿主软件弄坏。集中在这里认。
 */
const FRAGMENT_RULES = [
  { re: /extension sdk|sdk contracts?|addon\b/i, why: 'SDK 附属组件' },
  { re: /shared mui|\bmui\b|language pack|语言包|localization|proof \(/i, why: '语言包/共享组件' },
  { re: /headers? (libraries|and sources)|wmi provider|setup configuration|intellisense/i, why: '开发组件碎片' },
  { re: /targeting pack|templates?|workload|manifest|\bcontracts\b/i, why: '框架组件' },
  { re: /tools for (office|unity)|tools for office/i, why: '配套工具' },
  { re: /general midi|dls\b|soundfont/i, why: '音色库' },
  { re: /^vs_|application verifier|winappdeploy|kits configuration|ip over usb|msi development tools|script debugging common|vcpp_crt|sdk arm additions/i, why: 'Visual Studio 组件包' },
  { re: /office.*(component|\bime\b|proof|shared|64-bit)/i, why: 'Office 子组件' }
];

/** 驱动 / 硬件：卸了会让硬件不好用 */
const DRIVER_RULES = [
  { re: /driver|驱动/i, why: '驱动程序' },
  { re: /wireless adapter|网卡|bluetooth|蓝牙|chipset|芯片组|声卡|音频驱动|显卡驱动/i, why: '硬件组件' },
  { re: /parallel port|usb.*(filter|serial)|port joystick|hid\b/i, why: '外设支持' },
  { re: /winpcap|npcap|tap driver|wintun/i, why: '网络驱动' },
  { re: /^amd (software|settings|dvr|wvr)|ryzen ?master|branding64/i, why: 'AMD 硬件工具' },
  // AMD 挂出来的东西一律是显卡/芯片组配套（驱动、体验计划、安装器），没有例外
  { re: /^(amd|advanced micro devices)\b/i, why: 'AMD 硬件组件' },
  { re: /^nvidia|geforce experience|intel(r) (graphics|management)/i, why: '显卡驱动工具' }
];

/** 专业 / 开发 / 创作工具 */
const PRO_PUBLISHERS = [
  'adobe', 'autodesk', 'maxon', 'jetbrains', 'blackmagic', 'avid', 'foundry',
  'sidefx', 'solidworks', 'ansys', 'dassault', 'siemens', 'mathworks', 'wolfram',
  'corel', 'vmware', 'oracle', 'citrix', 'unity technologies', 'epic games',
  'the foundry', 'red giant', 'boris fx', 'redshift', 'chaos group', 'techsmith',
  'wondershare', 'aiseesoft', 'imagination technologies', 'altium', 'labcenter'
];
const PRO_NAME_WORDS = [
  'photoshop', 'illustrator', 'indesign', 'lightroom', 'premiere', 'after effects',
  'audition', 'animate cc', 'dreamweaver', 'acrobat', 'autocad', 'revit', 'inventor',
  '3ds max', 'maya', 'cinema 4d', 'houdini', 'nuke', 'blender', 'zbrush', 'substance',
  'sketchup', 'rhino', 'catia', 'solidworks', 'ansys', 'matlab', 'rstudio', 'labview',
  'unity', 'unreal', 'visual studio', 'vs code', 'vscode', 'pycharm', 'intellij',
  'webstorm', 'goland', 'clion', 'rider', 'datagrip', 'android studio', 'xcode',
  'eclipse', 'sublime', 'postman', 'navicat', 'dbeaver', 'xshell', 'securecrt',
  'wireshark', 'fiddler', 'ida', 'ghidra', 'docker', 'vmware', 'virtualbox',
  'ollama', 'qoder', 'cursor', 'cuda', 'anaconda', 'miniconda', 'jupyter',
  'quartus', 'vivado', 'keil', 'iar', 'git bash', 'sdk',
  'python', 'plastic scm', 'deepseek harness', 'conda', 'wsl',
  'dev-c', 'ffmpeg', 'winscp', 'sftp', 'node.js', 'compiler'
];
const DAILY_PUBLISHERS = [
  'tencent', '腾讯', 'netease', '网易', 'baidu', '百度', 'alibaba', '阿里',
  'bytedance', '字节', 'kingsoft', '金山', 'wps', '360', 'qihoo', 'sogou', '搜狗',
  'google', 'mozilla', 'opera', 'thunder', '迅雷', 'bilibili', '哔哩哔哩',
  'iqiyi', '爱奇艺', 'youku', '优酷', 'kugou', 'kuwo', 'xunlei', 'huorong',
  '火绒', 'qihoo360', 'rising', '瑞星', 'lenovo', '联想', 'huawei', '华为',
  'xiaomi', '小米', 'zoom', 'slack', 'dropbox', 'evernote', 'notion', 'obsidian',
  'typora', 'telegram', 'discord', 'kook', 'rustdesk', 'surfshark', 'clash',
  'netease cloud music', 'sogou.com'
];
const DAILY_NAME_WORDS = [
  '浏览器', 'browser', '播放器', 'player', '网盘', '云盘', '下载', '连点',
  '录屏', '截图', '输入法', '解压', '压缩', '管家', '安全', '杀毒', '清理',
  'office', 'word', 'excel', 'powerpoint', 'wps', 'pdf', '聊天', '会议',
  '翻译', '词典', '笔记', '音乐', '视频', '剪辑', '直播', '网课', '驱动总裁',
  'winrar', '7-zip', 'bandizip', 'tim', 'wechat', '微信', 'qq', '钉钉', '飞书',
  'chrome', 'firefox', 'edge', 'safari', 'vlc', 'potplayer', 'kmplayer',
  'download manager', 'accelerator', '加速器', '抖音', 'acdsee', 'obs studio',
  '剪映', 'plugin', '插件', 'email', 'mail',
  'steam'  // 平台客户端本身算日常（装游戏用的），游戏本身另有判定
];

// 平台客户端：它们的 exe 出现在 UninstallString 里时，绝不能当成
// 「这个软件的安装目录」—— steam.exe 的目录是整个 Steam，删了掉一大片
const PLATFORM_CLIENTS = [
  'steam.exe', 'epicgameslauncher.exe', 'battle.net.exe', 'ubisoftconnect.exe',
  'uplay.exe', 'origin.exe', 'eadesktop.exe', 'ea app.exe', 'wegame.exe',
  'galaxyclient.exe', 'riotclientservices.exe', 'gameloop.exe'
];

// 有些软件的注册表名字是坏编码（UTF-8 字节被按 GBK 解出来），后面跟一大串垃圾字符。
// 正常软件名几乎不会用到这些区段的字符，所以拿它当「从这里开始是垃圾」的界标。
const GARBLE = /[\u0180-\u01FF\u0240-\u02FF\u0500-\u05FF\u0530-\u058F\u25A0-\u2BFF\uE000-\uF8FF\uFFF0-\uFFFF]/;

function cleanAppName(s) {
  const raw = String(s || '').replace(/[\u0000-\u001f\u007f\uFFFD]/g, '');
  // 两个界标取更早的那个：罕见字符（坏编码）或连续 3 个以上空格（排版错位）
  const marks = [raw.search(GARBLE), raw.search(/\s{3,}/)].filter(i => i > 1);
  const cut = marks.length ? Math.min.apply(null, marks) : -1;
  return raw.slice(0, cut > 1 ? cut : raw.length)
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s\-–—_,，。·|]+$/, '')
    .replace(/^[\s\-–—_,，。·|]+/, '')
    .trim()
    .slice(0, 80);
}

/**
 * @param {object} a 注册表条目 { name, pub, ver, loc, uninst, icon, size, sysc, parent, rel, msi }
 * @param {object} [memory] { 'a:名字': 'game' }
 * @returns {{cat:string, why:string, source:string, key:string, risk:number}}
 *   cat  daily | pro | game | runtime | driver | unknown
 *   risk 0 可卸 / 1 有风险 / 2 不该卸
 */
function classifyApp(a, memory) {
  const key = 'a:' + String(a.name || '').toLowerCase().trim();
  if (memory && memory[key]) {
    return { cat: memory[key], why: '按你上次的选择', source: 'memory', key, risk: riskOf(memory[key]) };
  }

  const name = cleanAppName(a.name);
  const pub = String(a.pub || '').toLowerCase();
  const loc = String(a.loc || '').toLowerCase();
  const uninst = String(a.uninst || '').toLowerCase();
  const icon = String(a.icon || '').toLowerCase();
  const hit = (cat, why, risk) => ({ cat, why, source: 'rule', key, risk });

  // 1) 注册表自己打的标：补丁 / 子组件 / 系统组件
  if (a.parent) return hit('runtime', `是「${a.parent}」的子组件`, 2);
  if (/^(update|hotfix|security update)$/i.test(String(a.rel || ''))) {
    return hit('runtime', 'Windows 补丁/更新', 2);
  }

  // 2) 大软件拆出来的碎片（语言包、SDK 附属、模板……）
  for (const r of FRAGMENT_RULES) {
    if (r.re.test(name)) return hit('runtime', `${r.why}，属于别的软件的一部分`, 2);
  }

  // 3) 驱动（先于运行库：驱动卸错了硬件直接不好使）
  for (const r of DRIVER_RULES) {
    if (r.re.test(name)) return hit('driver', `名称含「${r.why}」`, 1);
  }

  // 4) 运行库 —— 代价最大，规则要最宽
  for (const r of RUNTIME_RULES) {
    if (r.re.test(name)) {
      const soft = a.sysc ? '（系统组件，控制面板里默认不显示）' : '';
      return hit('runtime', `${r.why}${soft}`, 2);
    }
  }
  // Python / .NET 这类被拆成十几个条目的：隐藏的那些都是碎片
  if (a.sysc && /python|\.net|node|java|perl|ruby/i.test(name)) {
    return hit('runtime', '某个运行环境的一部分', 2);
  }

  // 4) 游戏 —— 最有把握的一类，因为平台留下了硬痕迹
  //    steam\games\ 是 Steam 给「非 Steam 游戏」放图标的固定目录：
  //    只要条目里有它，不管这游戏叫什么、写在哪，都是玩家库里的东西。
  if (/steamapps|steam:\/\/|\\steam\\games\\|\/epic games\/|riot games|gog games|ubisoft game launcher|wegameapps|battle\.net/.test(loc + ' ' + uninst + ' ' + icon)) {
    return hit('game', '装在游戏平台目录里', 0);
  }
  if (/(battlenet|uplay|origin|com\.epicgames\.launcher|goggalaxy|xbox|roblox|wegame|ea):\/\//.test(uninst)) {
    return hit('game', '由游戏平台管理', 0);
  }
  const gpub = has(pub, GAME_PUBLISHERS);
  const gstrong = has(name, STRONG_GAME_WORDS);
  if (gstrong) return hit('game', `名字是游戏「${gstrong}」`, 0);
  if (gpub) return hit('game', `发行商「${gpub}」`, 0);

  // 5) 专业 / 开发 / 创作
  const ppub = has(pub, PRO_PUBLISHERS);
  if (ppub) return hit('pro', `专业软件厂商「${ppub}」`, 0);
  const pname = has(name.toLowerCase(), PRO_NAME_WORDS);
  if (pname) return hit('pro', `名称含「${pname}」`, 0);

  // 6) 日常
  const dpub = has(pub, DAILY_PUBLISHERS);
  const dname = has(name.toLowerCase(), DAILY_NAME_WORDS);
  if (dname) return hit('daily', `名称含「${dname}」`, 0);
  if (dpub) return hit('daily', `常见厂商「${dpub}」`, 0);

  // 7) Microsoft 的软件要单独收尾：既不是运行库也不是游戏的那些
  if (/microsoft/.test(pub) || /microsoft/.test(name.toLowerCase())) {
    return hit('daily', '微软自家的工具', 0);
  }

  // 8) 判不出 —— 不硬塞分类，单独一列让用户自己看
  return { cat: 'unknown', why: '没有明显特征', source: 'rule', key, risk: 0 };
}

function riskOf(cat) {
  if (cat === 'runtime') return 2;
  if (cat === 'driver') return 1;
  return 0;
}

module.exports = {
  classifyShortcut, memoryKey, classifyApp, cleanAppName,
  RUNTIME_RULES, DRIVER_RULES, PRO_NAME_WORDS, DAILY_NAME_WORDS, PLATFORM_CLIENTS,
  GAME_URL_SCHEMES, GAME_PATH_HINTS, GAME_PUBLISHERS, TOOL_PUBLISHERS,
  GAME_NAME_WORDS, STRONG_GAME_WORDS, TOOL_NAME_WORDS
};
