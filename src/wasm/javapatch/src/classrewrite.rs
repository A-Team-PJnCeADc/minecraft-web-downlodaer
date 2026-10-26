// 类文件重写: 复刻 ART 的 ASM 写入行为, 供 GDIFF 补丁精确命中。
// ClassWriter(reader, 0) 按原字节复制常量池并去重, 新常量按首次请求顺序追加;
// 类/字段/方法属性按 JVMS 4.7 写出, Code 子属性为 StackMapTable -> LineNumberTable
// -> LocalVariableTable -> LocalVariableTypeTable。
// ldc 的常量池索引跨过 255 时指令变长, 此时跳转/switch/异常表/栈帧偏移全部重算。

use std::collections::HashMap;

pub const FLAG_STRIP_SIGS: u32 = 1;
pub const FLAG_SRC_FIX: u32 = 2;
pub const FLAG_IDS_FIX: u32 = 4;
// 不复制原常量池, 只保留实际引用的常量(SpecialSource 1.13-1.16 的行为)
pub const FLAG_FRESH_POOL: u32 = 8;
// SourceFile 的属性名与值都在写出阶段入池(1.21.x 的 ART 链需要)
pub const FLAG_SRC_AT_WRITE: u32 = 16;
pub const FLAG_INHERIT_METHODS: u32 = 32;
// 引导方法先登记参数再登记句柄(ASM 8+ 的行为; ASM 6 是先句柄后参数)
pub const FLAG_BSM_ARGS_FIRST: u32 = 64;
// 构造函数参数注解前移(ART 的 ParameterAnnotationFixer); SpecialSource 路径不做
pub const FLAG_PARAM_ANN_FIX: u32 = 128;

const ACC_DEPRECATED: u32 = 0x20000;

// 映射表

pub struct Maps {
    classes: HashMap<String, String>,
    fields: HashMap<(String, String, String), String>,
    methods: HashMap<(String, String, String), String>,
    // (owner, name) -> 新名; 仅在没有歧义时填
    methods_by_name: HashMap<(String, String), String>,
    params: HashMap<(String, String, String), Vec<(u8, String)>>,
    supers: HashMap<String, (Option<String>, Vec<String>)>,
}

impl Maps {
    pub fn parse(blob: &[u8]) -> Result<Maps, String> {
        let mut r = Reader { b: blob, p: 0 };
        if r.take(5) != b"RMAP1" {
            return Err("映射表头不匹配".into());
        }
        let mut classes = HashMap::new();
        for _ in 0..r.u4() {
            let a = r.string();
            let b = r.string();
            classes.insert(a, b);
        }
        let mut fields = HashMap::new();
        for _ in 0..r.u4() {
            let o = r.string();
            let n = r.string();
            let d = r.string();
            let t = r.string();
            fields.insert((o, n, d), t);
        }
        let mut methods = HashMap::new();
        let mut methods_by_name: HashMap<(String, String), String> = HashMap::new();
        let mut ambiguous: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
        for _ in 0..r.u4() {
            let o = r.string();
            let n = r.string();
            let d = r.string();
            let t = r.string();
            let by_name = (o.clone(), n.clone());
            match methods_by_name.get(&by_name) {
                Some(prev) if prev != &t => {
                    ambiguous.insert(by_name);
                }
                _ => {
                    methods_by_name.insert(by_name, t.clone());
                }
            }
            methods.insert((o, n, d), t);
        }
        for a in ambiguous {
            methods_by_name.remove(&a);
        }
        let mut params = HashMap::new();
        if r.p < blob.len() {
            for _ in 0..r.u4() {
                let o = r.string();
                let n = r.string();
                let d = r.string();
                let idx = r.u1();
                let name = r.string();
                params
                    .entry((o, n, d))
                    .or_insert_with(Vec::new)
                    .push((idx, name));
            }
        }
        let mut supers: HashMap<String, (Option<String>, Vec<String>)> = HashMap::new();
        if r.p < blob.len() {
            for _ in 0..r.u4() {
                let name = r.string();
                let sup = r.string();
                let sup = if sup.is_empty() { None } else { Some(sup) };
                let n = r.u2() as usize;
                let mut ifaces = Vec::with_capacity(n);
                for _ in 0..n {
                    ifaces.push(r.string());
                }
                supers.insert(name, (sup, ifaces));
            }
        }
        Ok(Maps {
            classes,
            fields,
            methods,
            methods_by_name,
            params,
            supers,
        })
    }

    fn class(&self, name: &str) -> String {
        // 数组类型: 映射元素类型后把维度前缀补回去
        if let Some(rest) = name.strip_prefix('[') {
            let dims = name.len() - name.trim_start_matches('[').len();
            let prefix = "[".repeat(dims);
            let elem = &name[dims..];
            if let Some(inner) = elem.strip_prefix('L').and_then(|x| x.strip_suffix(';')) {
                return format!("{prefix}L{};", self.class(inner));
            }
            return format!("{prefix}{elem}");
        }
        self.classes.get(name).cloned().unwrap_or_else(|| name.to_string())
    }


    fn field(&self, owner: &str, name: &str, desc: &str) -> String {
        self.resolve_field(owner, name, desc, 0)
            .unwrap_or_else(|| name.to_string())
    }

    fn resolve_field(&self, owner: &str, name: &str, desc: &str, depth: u32) -> Option<String> {
        if depth > 48 {
            return None;
        }
        if let Some(v) = self
            .fields
            .get(&(owner.to_string(), name.to_string(), desc.to_string()))
        {
            return Some(v.clone());
        }
        if let Some((sup, ifaces)) = self.supers.get(owner) {
            if let Some(s) = sup {
                if let Some(v) = self.resolve_field(s, name, desc, depth + 1) {
                    return Some(v);
                }
            }
            for i in ifaces {
                if let Some(v) = self.resolve_field(i, name, desc, depth + 1) {
                    return Some(v);
                }
            }
        }
        None
    }

    fn method_by_name(&self, owner: &str, name: &str) -> Option<String> {
        self.methods_by_name
            .get(&(owner.to_string(), name.to_string()))
            .cloned()
    }

    fn method(&self, owner: &str, name: &str, desc: &str) -> String {
        if name.starts_with('<') {
            return name.to_string();
        }
        self.resolve_method(owner, name, desc, 0)
            .unwrap_or_else(|| name.to_string())
    }

    fn resolve_method(&self, owner: &str, name: &str, desc: &str, depth: u32) -> Option<String> {
        if depth > 48 {
            return None;
        }
        if depth == 0 && !inherit_methods() {
            return self.methods.get(&(owner.to_string(), name.to_string(), desc.to_string())).cloned();
        }
        if let Some(v) = self
            .methods
            .get(&(owner.to_string(), name.to_string(), desc.to_string()))
        {
            return Some(v.clone());
        }
        if let Some((sup, ifaces)) = self.supers.get(owner) {
            if let Some(s) = sup {
                if let Some(v) = self.resolve_method(s, name, desc, depth + 1) {
                    return Some(v);
                }
            }
            for i in ifaces {
                if let Some(v) = self.resolve_method(i, name, desc, depth + 1) {
                    return Some(v);
                }
            }
        } else if depth == 0 && crate::trace_on() {
            crate::trace_push(&format!("NOHIER {owner} {name} {desc}"));
        }
        None
    }

    // 描述符中的类名替换
    pub fn desc(&self, desc: &str) -> String {
        let b = desc.as_bytes();
        let mut out = String::with_capacity(desc.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'L' {
                let start = i + 1;
                let mut j = start;
                while j < b.len() && b[j] != b';' {
                    j += 1;
                }
                if j >= b.len() {
                    return desc.to_string();
                }
                out.push('L');
                out.push_str(&self.class(&desc[start..j]));
                out.push(';');
                i = j + 1;
            } else {
                out.push(b[i] as char);
                i += 1;
            }
        }
        out
    }

    // 泛型签名: 替换其中的类和内部类简单名, 类型变量原样保留
    pub fn signature(&self, sig: &str) -> String {
        let b = sig.as_bytes();
        let mut out = String::with_capacity(sig.len() + 16);
        let mut i = 0usize;
        self.sig_scan(b, &mut i, &mut out);
        out
    }

    // 顶层: 类型形参区与普通类型混合出现
    fn sig_scan(&self, b: &[u8], i: &mut usize, out: &mut String) {
        while *i < b.len() {
            match b[*i] {
                b'<' => {
                    *i += 1;
                    out.push('<');
                    self.sig_params(b, i, out);
                }
                b'L' => self.sig_class(b, i, out),
                c => {
                    out.push(c as char);
                    *i += 1;
                }
            }
        }
    }

    // 类型形参: 名字到 ':', 之后类上界与若干接口上界
    fn sig_params(&self, b: &[u8], i: &mut usize, out: &mut String) {
        while *i < b.len() && b[*i] != b'>' {
            let st = *i;
            while *i < b.len() && b[*i] != b':' && b[*i] != b'>' {
                *i += 1;
            }
            out.push_str(&String::from_utf8_lossy(&b[st..*i]));
            if *i < b.len() && b[*i] == b':' {
                out.push(':');
                *i += 1;
            }
            if *i < b.len() && b[*i] != b':' && b[*i] != b'>' {
                self.sig_one(b, i, out);
            }
            while *i < b.len() && b[*i] == b':' {
                out.push(':');
                *i += 1;
                self.sig_one(b, i, out);
            }
        }
        if *i < b.len() {
            out.push('>');
            *i += 1;
        }
    }

    fn sig_one(&self, b: &[u8], i: &mut usize, out: &mut String) {
        match b.get(*i) {
            Some(b'L') => self.sig_class(b, i, out),
            Some(b'[') => {
                out.push('[');
                *i += 1;
                self.sig_one(b, i, out);
            }
            Some(b'T') => {
                let st = *i;
                *i += 1;
                while *i < b.len() && b[*i] != b';' {
                    *i += 1;
                }
                if *i < b.len() {
                    *i += 1;
                }
                out.push_str(&String::from_utf8_lossy(&b[st..*i]));
            }
            Some(&c) => {
                out.push(c as char);
                *i += 1;
            }
            None => {}
        }
    }

    // 解析一个类类型签名: Lpkg/Outer<...>.Inner<...>;
    fn sig_class(&self, b: &[u8], i: &mut usize, out: &mut String) {
        let mut p = *i + 1;
        let start = p;
        while p < b.len() && b[p] != b'<' && b[p] != b'.' && b[p] != b';' {
            p += 1;
        }
        let head = String::from_utf8_lossy(&b[start..p]).into_owned();
        let mut orig = head.clone();
        let mut mapped = self.class(&head);
        out.push('L');
        out.push_str(&mapped);
        *i = p;
        loop {
            if *i < b.len() && b[*i] == b'<' {
                out.push('<');
                *i += 1;
                while *i < b.len() && b[*i] != b'>' {
                    if b[*i] == b'L' {
                        self.sig_class(b, i, out);
                    } else {
                        out.push(b[*i] as char);
                        *i += 1;
                    }
                }
                if *i < b.len() {
                    out.push('>');
                    *i += 1;
                }
                continue;
            }
            if *i < b.len() && b[*i] == b'.' {
                *i += 1;
                let s2 = *i;
                let mut q = s2;
                while q < b.len() && b[q] != b'<' && b[q] != b'.' && b[q] != b';' {
                    q += 1;
                }
                let inner = String::from_utf8_lossy(&b[s2..q]).into_owned();
                // 段里已经带 '$' 时是完整二进制名, 直接查表; 否则按 外层$段 拼
                let m = if inner.contains('$') {
                    self.class(&inner)
                } else {
                    orig.push('$');
                    orig.push_str(&inner);
                    self.class(&orig)
                };
                let simple = match m.rfind('$') {
                    Some(k) => m[k + 1..].to_string(),
                    None => inner.clone(),
                };
                mapped.push('.');
                mapped.push_str(&simple);
                out.push('.');
                out.push_str(&simple);
                *i = q;
                continue;
            }
            break;
        }
        if *i < b.len() && b[*i] == b';' {
            out.push(';');
            *i += 1;
        }
    }
}

// 读取

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn u1(&mut self) -> u8 {
        let v = self.b[self.p];
        self.p += 1;
        v
    }
    fn u2(&mut self) -> u16 {
        let v = u16::from_be_bytes([self.b[self.p], self.b[self.p + 1]]);
        self.p += 2;
        v
    }
    fn u4(&mut self) -> u32 {
        let v = u32::from_be_bytes([
            self.b[self.p],
            self.b[self.p + 1],
            self.b[self.p + 2],
            self.b[self.p + 3],
        ]);
        self.p += 4;
        v
    }
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        s
    }
    fn string(&mut self) -> String {
        let n = self.u2() as usize;
        String::from_utf8_lossy(self.take(n)).into_owned()
    }
}

// 常量池

#[derive(Clone)]
struct CpEntry {
    tag: u8,
    a: u32,
    b: u32,
}

struct Cp<'a> {
    raw: &'a [u8],
    entries: Vec<Option<CpEntry>>,
    keys: HashMap<String, u16>,
    appended: Vec<u8>,
    next: u16,
    strings: Vec<Option<String>>,
}

impl<'a> Cp<'a> {
    fn parse(class: &'a [u8], fresh: bool) -> Result<Cp<'a>, String> {
        let count = u16::from_be_bytes([class[8], class[9]]);
        let mut entries: Vec<Option<CpEntry>> = vec![None; count as usize];
        let mut strings: Vec<Option<String>> = vec![None; count as usize];
        let mut p = 10usize;
        let mut i = 1u16;
        while i < count {
            let tag = class[p];
            let (a, b, adv) = match tag {
                1 => {
                    let len = u16::from_be_bytes([class[p + 1], class[p + 2]]) as usize;
                    let s = decode_mutf8(&class[p + 3..p + 3 + len]);
                    strings[i as usize] = Some(s);
                    (0, 0, 3 + len)
                }
                3 | 4 => (
                    u32::from_be_bytes([class[p + 1], class[p + 2], class[p + 3], class[p + 4]]),
                    0,
                    5,
                ),
                5 | 6 => (
                    u32::from_be_bytes([class[p + 1], class[p + 2], class[p + 3], class[p + 4]]),
                    u32::from_be_bytes([class[p + 5], class[p + 6], class[p + 7], class[p + 8]]),
                    9,
                ),
                7 | 8 | 16 | 19 | 20 => (u16::from_be_bytes([class[p + 1], class[p + 2]]) as u32, 0, 3),
                9 | 10 | 11 | 12 | 17 | 18 => (
                    u16::from_be_bytes([class[p + 1], class[p + 2]]) as u32,
                    u16::from_be_bytes([class[p + 3], class[p + 4]]) as u32,
                    5,
                ),
                15 => (
                    class[p + 1] as u32,
                    u16::from_be_bytes([class[p + 2], class[p + 3]]) as u32,
                    4,
                ),
                other => return Err(format!("未知常量池 tag {other}")),
            };
            entries[i as usize] = Some(CpEntry { tag, a, b });
            p += adv;
            if tag == 5 || tag == 6 {
                i += 2;
            } else {
                i += 1;
            }
        }
        let raw = if fresh { &class[0..0] } else { &class[10..p] };
        let mut cp = Cp {
            raw,
            entries,
            keys: HashMap::new(),
            appended: Vec::new(),
            next: if fresh { 1 } else { count },
            strings,
        };
        if !fresh {
            for idx in 1..count as usize {
                if let Some(k) = cp.key_at(idx) {
                    cp.keys.entry(k).or_insert(idx as u16);
                }
            }
        }
        Ok(cp)
    }

    fn utf8_of(&self, idx: u16) -> String {
        self.strings.get(idx as usize).cloned().flatten().unwrap_or_default()
    }

    fn class_name_of(&self, idx: u16) -> String {
        match self.entries.get(idx as usize).cloned().flatten() {
            Some(e) if e.tag == 7 => self.utf8_of(e.a as u16),
            _ => String::new(),
        }
    }

    fn member_of(&self, idx: u16) -> Option<(u8, String, String, String)> {
        let e = self.entries.get(idx as usize).cloned().flatten()?;
        if !(e.tag == 9 || e.tag == 10 || e.tag == 11) {
            return None;
        }
        let (n, d) = self.nat_of(e.b as u16);
        Some((e.tag, self.class_name_of(e.a as u16), n, d))
    }

    fn nat_of(&self, idx: u16) -> (String, String) {
        match self.entries.get(idx as usize).cloned().flatten() {
            Some(e) if e.tag == 12 => (self.utf8_of(e.a as u16), self.utf8_of(e.b as u16)),
            _ => (String::new(), String::new()),
        }
    }

    fn key_at(&self, idx: usize) -> Option<String> {
        let e = self.entries.get(idx).cloned().flatten()?;
        Some(match e.tag {
            1 => format!("U:{}", self.utf8_of(idx as u16)),
            7 => format!("C:{}", self.utf8_of(e.a as u16)),
            8 => format!("S:{}", self.utf8_of(e.a as u16)),
            16 => format!("T:{}", self.utf8_of(e.a as u16)),
            12 => format!("N:{}:{}", self.utf8_of(e.a as u16), self.utf8_of(e.b as u16)),
            9 | 10 | 11 => {
                let (n, d) = self.nat_of(e.b as u16);
                format!("R:{}:{}:{n}:{d}", e.tag, self.class_name_of(e.a as u16))
            }
            15 => {
                // e.b 是 Fieldref/Methodref 索引, 名称与描述符要从该引用自己的 NameAndType 取
                let r = self.entries.get(e.b as usize).cloned().flatten()?;
                let (n, d) = self.nat_of(r.b as u16);
                format!("H:{}:{}:{n}:{d}", e.a, self.class_name_of(r.a as u16))
            }
            17 | 18 => {
                let (n, d) = self.nat_of(e.b as u16);
                format!("{}:{}:{n}:{d}", e.tag, e.a)
            }
            3 | 4 => format!("V:{}:{}", e.tag, e.a),
            5 | 6 => format!("V:{}:{}:{}", e.tag, e.a, e.b),
            _ => return None,
        })
    }

    fn push(&mut self, tag: u8, body: &[u8], key: Option<String>) -> u16 {
        let idx = self.next;
        if crate::trace_on() {
            crate::trace_push(&format!(
                "{}|{}|{}",
                idx,
                tag,
                key.as_deref().unwrap_or("?").replace(['\n', '\r'], " ")
            ));
        }
        self.appended.push(tag);
        self.appended.extend_from_slice(body);
        self.next += if tag == 5 || tag == 6 { 2 } else { 1 };
        if let Some(k) = key {
            self.keys.insert(k, idx);
        }
        idx
    }

    fn add_utf8(&mut self, s: &str) -> u16 {
        let key = format!("U:{s}");
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let bytes = encode_mutf8(s);
        let mut body = Vec::with_capacity(bytes.len() + 2);
        body.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        body.extend_from_slice(&bytes);
        self.push(1, &body, Some(key))
    }

    fn add_class(&mut self, name: &str) -> u16 {
        let key = format!("C:{name}");
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let u = self.add_utf8(name);
        self.push(7, &u.to_be_bytes(), Some(key))
    }

    fn add_name_type(&mut self, name: &str, desc: &str) -> u16 {
        let key = format!("N:{name}:{desc}");
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let n = self.add_utf8(name);
        let d = self.add_utf8(desc);
        let mut body = Vec::new();
        body.extend_from_slice(&n.to_be_bytes());
        body.extend_from_slice(&d.to_be_bytes());
        self.push(12, &body, Some(key))
    }

    fn add_ref(&mut self, tag: u8, owner: &str, name: &str, desc: &str) -> u16 {
        let key = format!("R:{tag}:{owner}:{name}:{desc}");
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let c = self.add_class(owner);
        let nt = self.add_name_type(name, desc);
        let mut body = Vec::new();
        body.extend_from_slice(&c.to_be_bytes());
        body.extend_from_slice(&nt.to_be_bytes());
        self.push(tag, &body, Some(key))
    }

    fn add_literal(&mut self, tag: u8, bits: u64) -> u16 {
        // 与 key_at 生成的键一致, 复制模式下才能命中原条目
        let key = if tag == 5 || tag == 6 {
            format!("V:{tag}:{}:{}", (bits >> 32) as u32, bits as u32)
        } else {
            format!("V:{tag}:{}", bits as u32)
        };
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let body = if tag == 5 || tag == 6 {
            bits.to_be_bytes().to_vec()
        } else {
            (bits as u32).to_be_bytes().to_vec()
        };
        self.push(tag, &body, Some(key))
    }

    fn add_string(&mut self, s: &str) -> u16 {
        let key = format!("S:{s}");
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let u = self.add_utf8(s);
        self.push(8, &u.to_be_bytes(), Some(key))
    }

    fn add_method_handle(&mut self, kind: u8, tag: u8, owner: &str, name: &str, desc: &str) -> u16 {
        let key = format!("H:{kind}:{owner}:{name}:{desc}");
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let r = self.add_ref(tag, owner, name, desc);
        let mut body = vec![kind];
        body.extend_from_slice(&r.to_be_bytes());
        self.push(15, &body, Some(key))
    }

    fn add_method_type(&mut self, desc: &str) -> u16 {
        let key = format!("T:{desc}");
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let u = self.add_utf8(desc);
        self.push(16, &u.to_be_bytes(), Some(key))
    }

    fn add_invoke_dynamic(&mut self, bsm: u16, name: &str, desc: &str) -> u16 {
        // 键必须与 key_at 对 tag 18 生成的格式一致, 否则复制模式下命不中原条目
        let key = format!("18:{bsm}:{name}:{desc}");
        if crate::trace_on() {
            let hit = if self.keys.contains_key(&key) { "HIT" } else { "NEW" };
            crate::trace_push(&format!("INDYKEY {hit} bsm={bsm} name={name} desc={desc}"));
        }
        if let Some(&i) = self.keys.get(&key) {
            return i;
        }
        let nt = self.add_name_type(name, desc);
        let mut body = Vec::new();
        body.extend_from_slice(&bsm.to_be_bytes());
        body.extend_from_slice(&nt.to_be_bytes());
        self.push(18, &body, Some(key))
    }

    fn emit(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.next.to_be_bytes());
        out.extend_from_slice(self.raw);
        out.extend_from_slice(&self.appended);
    }
}

// 属性

#[derive(Clone)]
struct Attr {
    name_idx: u16,
    off: usize,
    len: usize,
}

fn read_attrs(class: &[u8], mut p: usize) -> Result<(Vec<Attr>, usize), String> {
    let n = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
    p += 2;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let name_idx = u16::from_be_bytes([class[p], class[p + 1]]);
        let len =
            u32::from_be_bytes([class[p + 2], class[p + 3], class[p + 4], class[p + 5]]) as usize;
        let off = p + 6;
        out.push(Attr { name_idx, off, len });
        p = off + len;
    }
    Ok((out, p))
}

// 成员输出结构

struct FieldOut {
    access: u16,
    name: u16,
    desc: u16,
    sig: u16,
    constant: Option<u16>,
    deprecated: bool,
    anns: Anns,
}

struct MethodOut {
    access: u16,
    deprecated: bool,
    name: u16,
    desc: u16,
    sig: u16,
    exceptions: Vec<u16>,
    code: Option<CodeOut>,
    anns: Anns,
    param_rv: Option<ParamAnns>,
    param_ri: Option<ParamAnns>,
    default_value: Option<Vec<u8>>,
    method_params: Option<Vec<u8>>,
    // 属性被丢弃但属性名仍要留在常量池(ART 0.1.25)
    orphan_param_rv: bool,
    orphan_param_ri: bool,
}

struct CodeOut {
    max_stack: u16,
    max_locals: u16,
    code: Vec<u8>,
    handlers: Vec<(u16, u16, u16, u16)>,
    smt: Option<Vec<Frame>>,
    smt_raw: Option<SmtOut>,
    lnt: Option<Vec<(u16, u16)>>,
    lnt_raw: Option<Vec<u8>>,
    lvt: Option<Vec<LvtEntry>>,
    lvt_raw: Option<Vec<u8>>,
    lvtt: Option<Vec<LvtEntry>>,
    lvtt_raw: Option<Vec<u8>>,
    layout_changed: bool,
    rv_type: Option<Vec<Vec<u8>>>,
    ri_type: Option<Vec<Vec<u8>>>,
}

// 栈帧类型与局部变量名/描述符在写出阶段入池
struct SmtOut {
    bytes: Vec<u8>,
    refs: Vec<(usize, String)>,
}

struct LvtEntry {
    start: u16,
    length: u16,
    name: String,
    desc: String,
    index: u16,
}

// 主流程


// 当前类的 invokedynamic 引导信息: (是否 LambdaMetafactory, SAM 描述符)
thread_local! {
    static LAMBDA_BSM: std::cell::RefCell<Vec<Option<String>>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn lambda_sam_desc(bsm: u16) -> Option<String> {
    LAMBDA_BSM.with(|slot| slot.borrow().get(bsm as usize).cloned().flatten())
}

// 注解、类型注解与 Record 组件: 常量在访问阶段入池, 结构原样保留
#[derive(Default, Clone)]
struct Anns {
    rv: Vec<Vec<u8>>,
    ri: Vec<Vec<u8>>,
    rv_type: Vec<Vec<u8>>,
    ri_type: Vec<Vec<u8>>,
}

impl Anns {
    fn attr_count(&self) -> u16 {
        let mut n = 0;
        if !self.rv.is_empty() { n += 1; }
        if !self.ri.is_empty() { n += 1; }
        if !self.rv_type.is_empty() { n += 1; }
        if !self.ri_type.is_empty() { n += 1; }
        n
    }
}

struct ParamAnns {
    count: u8,
    per: Vec<Vec<Vec<u8>>>,
}

struct RecordComp {
    name: u16,
    desc: u16,
    sig: u16,
    anns: Anns,
}

fn u2_at(b: &[u8], p: usize) -> u16 {
    u16::from_be_bytes([b[p], b[p + 1]])
}

fn read_anns(cp: &mut Cp, maps: &Maps, class: &[u8], off: usize) -> Result<Vec<Vec<u8>>, String> {
    let n = u2_at(class, off) as usize;
    let mut p = off + 2;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let mut bytes = Vec::new();
        p = read_annotation(cp, maps, class, p, &mut bytes)?;
        out.push(bytes);
    }
    Ok(out)
}

fn read_type_anns(cp: &mut Cp, maps: &Maps, class: &[u8], off: usize) -> Result<Vec<Vec<u8>>, String> {
    read_type_anns_map(cp, maps, class, off, None)
}

fn read_type_anns_map(
    cp: &mut Cp,
    maps: &Maps,
    class: &[u8],
    off: usize,
    map: Option<&[(usize, usize)]>,
) -> Result<Vec<Vec<u8>>, String> {
    let n = u2_at(class, off) as usize;
    let mut p = off + 2;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let mut bytes = Vec::new();
        p = read_type_annotation(cp, maps, class, p, &mut bytes, map)?;
        out.push(bytes);
    }
    Ok(out)
}

fn map_pc(map: &[(usize, usize)], old: usize) -> usize {
    match map.binary_search_by_key(&old, |e| e.0) {
        Ok(k) => map[k].1,
        Err(k) => {
            if k == 0 {
                0
            } else {
                map[k - 1].1 + (old - map[k - 1].0)
            }
        }
    }
}

fn read_annotation(
    cp: &mut Cp,
    maps: &Maps,
    class: &[u8],
    mut p: usize,
    out: &mut Vec<u8>,
) -> Result<usize, String> {
    let type_idx = u2_at(class, p);
    let desc = maps.desc(&cp.utf8_of(type_idx));
    out.extend_from_slice(&cp.add_utf8(&desc).to_be_bytes());
    let n = u2_at(class, p + 2);
    out.extend_from_slice(&n.to_be_bytes());
    p += 4;
    for _ in 0..n {
        let name_idx = u2_at(class, p);
        let name = cp.utf8_of(name_idx);
        out.extend_from_slice(&cp.add_utf8(&name).to_be_bytes());
        p = read_element_value(cp, maps, class, p + 2, out)?;
    }
    Ok(p)
}

fn read_element_value(
    cp: &mut Cp,
    maps: &Maps,
    class: &[u8],
    mut p: usize,
    out: &mut Vec<u8>,
) -> Result<usize, String> {
    let tag = class[p];
    out.push(tag);
    p += 1;
    match tag {
        b's' => {
            let s = cp.utf8_of(u2_at(class, p));
            out.extend_from_slice(&cp.add_utf8(&s).to_be_bytes());
            p += 2;
        }
        b'B' | b'C' | b'D' | b'F' | b'I' | b'J' | b'S' | b'Z' => {
            let idx = u2_at(class, p);
            out.extend_from_slice(&remap_constant(cp, maps, idx)?.to_be_bytes());
            p += 2;
        }
        b'c' => {
            let d = maps.desc(&cp.utf8_of(u2_at(class, p)));
            out.extend_from_slice(&cp.add_utf8(&d).to_be_bytes());
            p += 2;
        }
        b'e' => {
            let d = maps.desc(&cp.utf8_of(u2_at(class, p)));
            let v = cp.utf8_of(u2_at(class, p + 2));
            out.extend_from_slice(&cp.add_utf8(&d).to_be_bytes());
            out.extend_from_slice(&cp.add_utf8(&v).to_be_bytes());
            p += 4;
        }
        b'@' => {
            p = read_annotation(cp, maps, class, p, out)?;
        }
        b'[' => {
            let n = u2_at(class, p);
            out.extend_from_slice(&n.to_be_bytes());
            p += 2;
            for _ in 0..n {
                p = read_element_value(cp, maps, class, p, out)?;
            }
        }
        other => return Err(format!("未知注解元素标签 {}", other as char)),
    }
    Ok(p)
}

fn read_type_annotation(
    cp: &mut Cp,
    maps: &Maps,
    class: &[u8],
    mut p: usize,
    out: &mut Vec<u8>,
    map: Option<&[(usize, usize)]>,
) -> Result<usize, String> {
    let tt = class[p];
    out.push(tt);
    p += 1;
    if (tt == 0x40 || tt == 0x41) && map.is_some() {
        // 局部变量目标的 (start_pc, length) 跟随代码布局
        let m = map.unwrap();
        let n = u2_at(class, p) as usize;
        out.extend_from_slice(&(n as u16).to_be_bytes());
        let mut q = p + 2;
        for _ in 0..n {
            let st = u2_at(class, q) as usize;
            let len = u2_at(class, q + 2) as usize;
            let idx = u2_at(class, q + 4);
            let ns = map_pc(m, st);
            let ne = map_pc(m, st + len);
            out.extend_from_slice(&(ns as u16).to_be_bytes());
            out.extend_from_slice(&((ne - ns) as u16).to_be_bytes());
            out.extend_from_slice(&idx.to_be_bytes());
            q += 6;
        }
        p += 2 + 6 * n;
    } else {
        let info = target_info_len(tt, class, p);
        out.extend_from_slice(&class[p..p + info]);
        p += info;
    }
    let path_len = class[p] as usize;
    out.push(class[p]);
    p += 1;
    out.extend_from_slice(&class[p..p + 2 * path_len]);
    p += 2 * path_len;
    read_annotation(cp, maps, class, p, out)
}

fn target_info_len(tt: u8, b: &[u8], p: usize) -> usize {
    match tt {
        0x00 | 0x01 => 1,
        0x10 => 2,
        0x11 | 0x12 => 2,
        0x13 | 0x14 | 0x15 => 0,
        0x16 => 1,
        0x17 => 2,
        0x40 | 0x41 => 2 + 6 * u2_at(b, p) as usize,
        0x42 => 2,
        0x43..=0x46 => 2,
        0x47..=0x4B => 3,
        _ => 0,
    }
}

fn read_param_anns(
    cp: &mut Cp,
    maps: &Maps,
    class: &[u8],
    off: usize,
) -> Result<ParamAnns, String> {
    let count = class[off];
    let mut p = off + 1;
    let mut per = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let n = u2_at(class, p) as usize;
        p += 2;
        let mut list = Vec::with_capacity(n);
        for _ in 0..n {
            let mut bytes = Vec::new();
            p = read_annotation(cp, maps, class, p, &mut bytes)?;
            list.push(bytes);
        }
        per.push(list);
    }
    Ok(ParamAnns { count, per })
}

fn write_ann_attr(out: &mut Vec<u8>, cp: &mut Cp, name: &str, anns: &[Vec<u8>]) {
    out.extend_from_slice(&cp.add_utf8(name).to_be_bytes());
    let size: usize = 2 + anns.iter().map(|a| a.len()).sum::<usize>();
    out.extend_from_slice(&(size as u32).to_be_bytes());
    out.extend_from_slice(&(anns.len() as u16).to_be_bytes());
    for a in anns {
        out.extend_from_slice(a);
    }
}

fn write_param_ann_attr(out: &mut Vec<u8>, cp: &mut Cp, name: &str, p: &ParamAnns) {
    let size: usize = 1
        + p.per
            .iter()
            .map(|v| 2 + v.iter().map(|a| a.len()).sum::<usize>())
            .sum::<usize>();
    out.extend_from_slice(&cp.add_utf8(name).to_be_bytes());
    out.extend_from_slice(&(size as u32).to_be_bytes());
    out.push(p.count);
    for v in &p.per {
        out.extend_from_slice(&(v.len() as u16).to_be_bytes());
        for a in v {
            out.extend_from_slice(a);
        }
    }
}

fn read_record(
    cp: &mut Cp,
    maps: &Maps,
    class: &[u8],
    off: usize,
    owner: &str,
    flags: u32,
) -> Result<(Vec<RecordComp>, Vec<String>), String> {
    let n = u2_at(class, off) as usize;
    let mut p = off + 2;
    let mut out = Vec::with_capacity(n);
    let mut raws: Vec<String> = Vec::with_capacity(n);
    for _ in 0..n {
        let raw_name = cp.utf8_of(u2_at(class, p));
        raws.push(raw_name.clone());
        let raw_desc = cp.utf8_of(u2_at(class, p + 2));
        // 记录组件与同名字段共用映射
        let name = maps.field(owner, &raw_name, &raw_desc);
        let desc = maps.desc(&raw_desc);
        p += 4;
        // RecordComponentWriter 构造时先登记 name, desc, signature
        let name_i = cp.add_utf8(&name);
        let desc_i = cp.add_utf8(&desc);
        let mut sig = 0u16;
        let mut anns = Anns::default();
        let ac = u2_at(class, p) as usize;
        p += 2;
        if flags & FLAG_STRIP_SIGS == 0 {
            let mut q = p;
            for _ in 0..ac {
                let an = cp.utf8_of(u2_at(class, q));
                let alen = u32::from_be_bytes([class[q+2], class[q+3], class[q+4], class[q+5]]) as usize;
                if an == "Signature" && flags & FLAG_STRIP_SIGS == 0 {
                    sig = cp.add_utf8(&maps.signature(&cp.utf8_of(u2_at(class, q + 6))));
                }
                q += 6 + alen;
            }
        }
        for _ in 0..ac {
            let an = cp.utf8_of(u2_at(class, p));
            let alen = u32::from_be_bytes([class[p+2], class[p+3], class[p+4], class[p+5]]) as usize;
            let aoff = p + 6;
            match an.as_str() {
                "Signature" => {}
                "RuntimeVisibleAnnotations" => anns.rv = read_anns(cp, maps, class, aoff)?,
                "RuntimeInvisibleAnnotations" => anns.ri = read_anns(cp, maps, class, aoff)?,
                "RuntimeVisibleTypeAnnotations" => anns.rv_type = read_type_anns(cp, maps, class, aoff)?,
                "RuntimeInvisibleTypeAnnotations" => anns.ri_type = read_type_anns(cp, maps, class, aoff)?,
                other => return Err(format!("未处理的 Record 组件属性: {other}")),
            }
            p = aoff + alen;
        }
        out.push(RecordComp {
            name: name_i,
            desc: desc_i,
            sig,
            anns,
        });
    }
    Ok((out, raws))
}


// ParameterAnnotationFixer: 构造函数的参数注解整体前移合成参数个数
fn synthetic_param_prefix(cp: &Cp, class: &[u8], this_idx: u16, this_name: &str, access: u16) -> Vec<String> {
    if access & 0x4000 != 0 {
        return vec!["Ljava/lang/String;".to_string(), "I".to_string()];
    }
    let (mut p, ac) = match class_attrs_span(class) {
        Some(v) => v,
        None => return Vec::new(),
    };
    for _ in 0..ac {
        let ni = u2_at(class, p);
        let alen = u32::from_be_bytes([class[p + 2], class[p + 3], class[p + 4], class[p + 5]]) as usize;
        if cp.utf8_of(ni) == "InnerClasses" {
            let n = u2_at(class, p + 6) as usize;
            let mut q = p + 8;
            for _ in 0..n {
                let ii = u2_at(class, q);
                let oi = u2_at(class, q + 2);
                let ini = u2_at(class, q + 4);
                let acc = u2_at(class, q + 6);
                q += 8;
                if ii == this_idx && acc & 0x0208 == 0 && ini != 0 {
                    let outer = if oi != 0 {
                        cp.class_name_of(oi)
                    } else {
                        match this_name.rfind('$') {
                            Some(k) => this_name[..k].to_string(),
                            None => continue,
                        }
                    };
                    return vec![format!("L{outer};")];
                }
            }
        }
        p += 6 + alen;
    }
    Vec::new()
}

// 截取类属性区, 返回 (起始偏移, 属性个数)
fn class_attrs_span(class: &[u8]) -> Option<(usize, usize)> {
    let count = u16::from_be_bytes([class[8], class[9]]) as usize;
    let mut p = 10usize;
    let mut i = 1usize;
    while i < count {
        let tag = class[p];
        p += match tag {
            1 => 3 + u16::from_be_bytes([class[p + 1], class[p + 2]]) as usize,
            3 | 4 | 9 | 10 | 11 | 12 | 17 | 18 => 5,
            5 | 6 => 9,
            7 | 8 | 16 | 19 | 20 => 3,
            15 => 4,
            _ => return None,
        };
        i += if tag == 5 || tag == 6 { 2 } else { 1 };
    }
    p += 6;
    let ic = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
    p += 2 + 2 * ic;
    let fc = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
    p += 2;
    for _ in 0..fc {
        p += 6;
        let c = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
        p += 2;
        for _ in 0..c {
            let l = u32::from_be_bytes([class[p + 2], class[p + 3], class[p + 4], class[p + 5]]) as usize;
            p += 6 + l;
        }
    }
    let mc = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
    p += 2;
    for _ in 0..mc {
        p += 6;
        let c = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
        p += 2;
        for _ in 0..c {
            let l = u32::from_be_bytes([class[p + 2], class[p + 3], class[p + 4], class[p + 5]]) as usize;
            p += 6 + l;
        }
    }
    let n = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
    Some((p + 2, n))
}

// 描述符的前几个参数是否与合成参数前缀一致
fn desc_starts_with(desc: &str, prefix: &[String]) -> bool {
    let b = desc.as_bytes();
    let mut i = 1usize;
    for want in prefix {
        let start = i;
        if i >= b.len() {
            return false;
        }
        match b[i] {
            b'L' => {
                while i < b.len() && b[i] != b';' {
                    i += 1;
                }
                i += 1;
            }
            b'[' => {
                while i < b.len() && b[i] == b'[' {
                    i += 1;
                }
                if i < b.len() && b[i] == b'L' {
                    while i < b.len() && b[i] != b';' {
                        i += 1;
                    }
                }
                i += 1;
            }
            _ => i += 1,
        }
        if i > b.len() || &desc[start..i.min(desc.len())] != want.as_str() {
            return false;
        }
    }
    true
}

pub 
// class 文件用 modified UTF-8: NUL 编成 C0 80, 增补字符拆成两个三字节代理项
fn decode_mutf8(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len());
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if c < 0x80 {
            out.push(c as char);
            i += 1;
        } else if c & 0xE0 == 0xC0 && i + 1 < b.len() {
            let v = ((c as u32 & 0x1F) << 6) | (b[i + 1] as u32 & 0x3F);
            out.push(char::from_u32(v).unwrap_or('\u{FFFD}'));
            i += 2;
        } else if c & 0xF0 == 0xE0 && i + 2 < b.len() {
            let v = ((c as u32 & 0x0F) << 12)
                | ((b[i + 1] as u32 & 0x3F) << 6)
                | (b[i + 2] as u32 & 0x3F);
            if (0xD800..0xDC00).contains(&v) && i + 5 < b.len() && b[i + 3] & 0xF0 == 0xE0 {
                let lo = ((b[i + 3] as u32 & 0x0F) << 12)
                    | ((b[i + 4] as u32 & 0x3F) << 6)
                    | (b[i + 5] as u32 & 0x3F);
                if (0xDC00..0xE000).contains(&lo) {
                    let cp = 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00);
                    out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                    i += 6;
                    continue;
                }
            }
            out.push(char::from_u32(v).unwrap_or('\u{FFFD}'));
            i += 3;
        } else {
            out.push('\u{FFFD}');
            i += 1;
        }
    }
    out
}

fn encode_mutf8(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() + 8);
    for ch in s.chars() {
        let cp = ch as u32;
        if (1..0x80).contains(&cp) {
            out.push(cp as u8);
        } else if cp < 0x800 {
            out.push(0xC0 | (cp >> 6) as u8);
            out.push(0x80 | (cp & 0x3F) as u8);
        } else if cp < 0x10000 {
            out.push(0xE0 | (cp >> 12) as u8);
            out.push(0x80 | ((cp >> 6) & 0x3F) as u8);
            out.push(0x80 | (cp & 0x3F) as u8);
        } else {
            let v = cp - 0x10000;
            let hi = 0xD800 + (v >> 10);
            let lo = 0xDC00 + (v & 0x3FF);
            for c in [hi, lo] {
                out.push(0xE0 | (c >> 12) as u8);
                out.push(0x80 | ((c >> 6) & 0x3F) as u8);
                out.push(0x80 | (c & 0x3F) as u8);
            }
        }
    }
    out
}

pub fn remap_class(maps: &Maps, class: &[u8], flags: u32) -> Result<Vec<u8>, String> {
    if class.len() < 10 || class[0..4] != [0xCA, 0xFE, 0xBA, 0xBE] {
        return Err("不是 class 文件".into());
    }
    let mut cp = Cp::parse(class, flags & FLAG_FRESH_POOL != 0)?;
    let major = u16::from_be_bytes([class[6], class[7]]);

    // 常量池结束位置
    let mut p = 10usize;
    {
        let count = u16::from_be_bytes([class[8], class[9]]);
        let mut i = 1u16;
        while i < count {
            let tag = class[p];
            p += match tag {
                1 => 3 + u16::from_be_bytes([class[p + 1], class[p + 2]]) as usize,
                3 | 4 | 9 | 10 | 11 | 12 | 17 | 18 => 5,
                5 | 6 => 9,
                7 | 8 | 16 | 19 | 20 => 3,
                15 => 4,
                t => return Err(format!("未知常量池 tag {t}")),
            };
            i += if tag == 5 || tag == 6 { 2 } else { 1 };
        }
    }

    let access = u16::from_be_bytes([class[p], class[p + 1]]);
    let this_idx = u16::from_be_bytes([class[p + 2], class[p + 3]]);
    let super_idx = u16::from_be_bytes([class[p + 4], class[p + 5]]);
    p += 6;
    let iface_count = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
    p += 2;
    let mut ifaces = Vec::with_capacity(iface_count);
    for _ in 0..iface_count {
        ifaces.push(u16::from_be_bytes([class[p], class[p + 1]]));
        p += 2;
    }

    let this_name = cp.class_name_of(this_idx);

    // 字段/方法表(保留原始属性)
    struct Member {
        access: u16,
        name: String,
        desc: String,
        attrs: Vec<Attr>,
    }
    let mut fields: Vec<Member> = Vec::new();
    let fc = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
    p += 2;
    for _ in 0..fc {
        let a = u16::from_be_bytes([class[p], class[p + 1]]);
        let ni = u16::from_be_bytes([class[p + 2], class[p + 3]]);
        let di = u16::from_be_bytes([class[p + 4], class[p + 5]]);
        p += 6;
        let (attrs, np) = read_attrs(class, p)?;
        p = np;
        fields.push(Member { access: a, name: cp.utf8_of(ni), desc: cp.utf8_of(di), attrs });
    }
    let mut methods: Vec<Member> = Vec::new();
    let mc = u16::from_be_bytes([class[p], class[p + 1]]) as usize;
    p += 2;
    for _ in 0..mc {
        let a = u16::from_be_bytes([class[p], class[p + 1]]);
        let ni = u16::from_be_bytes([class[p + 2], class[p + 3]]);
        let di = u16::from_be_bytes([class[p + 4], class[p + 5]]);
        p += 6;
        let (attrs, np) = read_attrs(class, p)?;
        p = np;
        methods.push(Member { access: a, name: cp.utf8_of(ni), desc: cp.utf8_of(di), attrs });
    }
    let (class_attrs, _) = read_attrs(class, p)?;

    // 类级签名与 Deprecated 先取, 其余属性按 ASM 访问次序处理
    let mut signature: Option<String> = None;
    let mut deprecated = false;
    for a in &class_attrs {
        match cp.utf8_of(a.name_idx).as_str() {
            "Signature" => signature = Some(cp.utf8_of(u2_at(class, a.off))),
            "Deprecated" => deprecated = true,
            _ => {}
        }
    }

    // 访问阶段的入池顺序: 类名 -> 类签名 -> 父类 -> 接口
    let new_this = maps.class(&this_name);
    let this_class = cp.add_class(&new_this);
    let sig_idx = match &signature {
        Some(s) if flags & FLAG_STRIP_SIGS == 0 => cp.add_utf8(&maps.signature(s)),
        _ => 0,
    };
    let super_class = if super_idx == 0 {
        0
    } else {
        cp.add_class(&maps.class(&cp.class_name_of(super_idx)))
    };
    let iface_idx: Vec<u16> = ifaces
        .iter()
        .map(|&x| cp.add_class(&maps.class(&cp.class_name_of(x))))
        .collect();

    // 各属性的常量在处理时即时入池
    let mut src_name: Option<String> = None;
    let mut src_idx: Option<u16> = None;
    let mut inner_idx: Vec<(u16, u16, u16, u16)> = Vec::new();
    let mut encl_idx: Option<(u16, u16)> = None;
    let mut nest_host_idx: Option<u16> = None;
    let mut nest_member_idx: Vec<u16> = Vec::new();
    let mut permitted_idx: Vec<u16> = Vec::new();
    let mut bootstrap_attr: Option<Attr> = None;
    let mut class_anns = Anns::default();
    let mut record_comps: Vec<RecordComp> = Vec::new();
    let mut has_record_attr = false;
    let mut record_names: Vec<String> = Vec::new();

    // 属性名提前入池只适用于 1.21.x(installertools); ART 的属性名在 toByteArray 末尾才登记
    if flags & FLAG_SRC_AT_WRITE != 0
        && class_attrs.iter().any(|a| cp.utf8_of(a.name_idx) == "SourceFile")
    {
        cp.add_utf8("SourceFile");
    }

    // 按 ASM 的访问次序处理类属性
    fn attr_rank(cp: &Cp, a: &Attr) -> u32 {
        match cp.utf8_of(a.name_idx).as_str() {
            "SourceFile" => 10,
            "NestHost" => 20,
            "EnclosingMethod" => 30,
            "RuntimeVisibleAnnotations" => 40,
            "RuntimeInvisibleAnnotations" => 41,
            "RuntimeVisibleTypeAnnotations" => 42,
            "RuntimeInvisibleTypeAnnotations" => 43,
            "Deprecated" => 44,
            "Signature" => 45,
            "NestMembers" => 50,
            "PermittedSubclasses" => 60,
            "InnerClasses" => 70,
            "Record" => 80,
            "BootstrapMethods" => 95,
            _ => 90,
        }
    }
    let mut ordered: Vec<&Attr> = class_attrs.iter().collect();
    ordered.sort_by_key(|a| attr_rank(&cp, a));
    for a in ordered {
        match cp.utf8_of(a.name_idx).as_str() {
            "SourceFile" => {
                let orig = cp.utf8_of(u2_at(class, a.off));
                let name = if flags & FLAG_SRC_FIX != 0 {
                    let simple = new_this.rsplit('/').next().unwrap_or(&new_this);
                    let simple = match simple.find('$') {
                        Some(k) => &simple[..k],
                        None => simple,
                    };
                    format!("{simple}.java")
                } else {
                    orig
                };
                if flags & FLAG_SRC_FIX == 0 {
                    src_idx = Some(cp.add_utf8(&name));
                } else {
                    // 属性名先入池, 取值在写出阶段登记(1.21.x 的顺序)
                    cp.add_utf8("SourceFile");
                }
                src_name = Some(name);
            }
            "Signature" | "Deprecated" | "Synthetic" => {}
            "InnerClasses" => {
                let n = u2_at(class, a.off) as usize;
                let mut q = a.off + 2;
                for _ in 0..n {
                    let ii = u2_at(class, q);
                    let oi = u2_at(class, q + 2);
                    let ni = u2_at(class, q + 4);
                    let acc = u2_at(class, q + 6);
                    q += 8;
                    let c1 = cp.add_class(&maps.class(&cp.class_name_of(ii)));
                    let c2 = if oi == 0 {
                        0
                    } else {
                        cp.add_class(&maps.class(&cp.class_name_of(oi)))
                    };
                    let c3 = if ni == 0 {
                        0
                    } else {
                        let mapped = &maps.class(&cp.class_name_of(ii));
                        cp.add_utf8(&inner_simple_name(mapped, &cp.utf8_of(ni)))
                    };
                    inner_idx.push((c1, c2, c3, acc));
                }
            }
            "EnclosingMethod" => {
                let owner = cp.class_name_of(u2_at(class, a.off));
                let nt = u2_at(class, a.off + 2);
                let c = cp.add_class(&maps.class(&owner));
                let nt_idx = if nt == 0 {
                    0
                } else {
                    let (n, d) = cp.nat_of(nt);
                    cp.add_name_type(&maps.method(&owner, &n, &d), &maps.desc(&d))
                };
                encl_idx = Some((c, nt_idx));
            }
            "NestHost" => {
                nest_host_idx = Some(cp.add_class(&maps.class(&cp.class_name_of(u2_at(class, a.off)))));
            }
            "NestMembers" => {
                let n = u2_at(class, a.off) as usize;
                for k in 0..n {
                    let idx = u2_at(class, a.off + 2 + k * 2);
                    nest_member_idx.push(cp.add_class(&maps.class(&cp.class_name_of(idx))));
                }
            }
            "PermittedSubclasses" => {
                let n = u2_at(class, a.off) as usize;
                for k in 0..n {
                    let idx = u2_at(class, a.off + 2 + k * 2);
                    permitted_idx.push(cp.add_class(&maps.class(&cp.class_name_of(idx))));
                }
            }
            "Record" => {
                let (comps, raws) = read_record(&mut cp, maps, class, a.off, &this_name, flags)?;
                record_comps = comps;
                has_record_attr = true;
                record_names = raws;
            }
            "RuntimeVisibleAnnotations" => class_anns.rv = read_anns(&mut cp, maps, class, a.off)?,
            "RuntimeInvisibleAnnotations" => class_anns.ri = read_anns(&mut cp, maps, class, a.off)?,
            "RuntimeVisibleTypeAnnotations" => {
                class_anns.rv_type = read_type_anns(&mut cp, maps, class, a.off)?
            }
            "RuntimeInvisibleTypeAnnotations" => {
                class_anns.ri_type = read_type_anns(&mut cp, maps, class, a.off)?
            }
            "BootstrapMethods" => bootstrap_attr = Some(a.clone()),
            other => return Err(format!("未处理的类属性: {other}")),
        }
    }

    let mut field_out: Vec<FieldOut> = Vec::new();
    for f in &fields {
        let name_i = cp.add_utf8(&maps.field(&this_name, &f.name, &f.desc));
        let desc_i = cp.add_utf8(&maps.desc(&f.desc));
        let mut sig_i = 0;
        let mut deprecated = false;
        let mut constant = None;
        let mut anns = Anns::default();
        for a in &f.attrs {
            if cp.utf8_of(a.name_idx) == "Signature" && flags & FLAG_STRIP_SIGS == 0 {
                sig_i = cp.add_utf8(&maps.signature(&cp.utf8_of(u2_at(class, a.off))));
            }
        }
        for a in &f.attrs {
            match cp.utf8_of(a.name_idx).as_str() {
                "ConstantValue" => constant = Some(remap_constant(&mut cp, maps, u2_at(class, a.off))?),
                "Signature" => {}
                "Deprecated" => deprecated = true,
                "Synthetic" => {}
                "RuntimeVisibleAnnotations" => anns.rv = read_anns(&mut cp, maps, class, a.off)?,
                "RuntimeInvisibleAnnotations" => anns.ri = read_anns(&mut cp, maps, class, a.off)?,
                "RuntimeVisibleTypeAnnotations" => anns.rv_type = read_type_anns(&mut cp, maps, class, a.off)?,
                "RuntimeInvisibleTypeAnnotations" => anns.ri_type = read_type_anns(&mut cp, maps, class, a.off)?,
                other => return Err(format!("未处理的字段属性: {other}")),
            }
        }
        // record-fix: 记录组件的对应字段必须是 private final
        let mut access = f.access;
        if record_names.iter().any(|n| n == &f.name) {
            access |= 0x0002;
        }
        field_out.push(FieldOut {
            access,
            name: name_i,
            desc: desc_i,
            sig: sig_i,
            constant,
            deprecated,
            anns,
        });
    }

    // 仅 ART(复制常量池)路径有这一步; SpecialSource 路径不做
    let synth_prefix = if flags & FLAG_FRESH_POOL == 0 || flags & FLAG_PARAM_ANN_FIX != 0 {
        synthetic_param_prefix(&cp, class, this_idx, &this_name, access)
    } else {
        Vec::new()
    };
    let mut method_out: Vec<MethodOut> = Vec::new();
    // 每个类重置, 避免没有 BootstrapMethods 的类沿用上一个类的 lambda 信息
    match &bootstrap_attr {
        Some(a) => {
            let info = scan_lambda_bsm(&cp, class, a.off, a.len);
            LAMBDA_BSM.with(|slot| *slot.borrow_mut() = info);
        }
        None => LAMBDA_BSM.with(|slot| slot.borrow_mut().clear()),
    }

    // BootstrapMethods 的句柄与参数在遇到 invokedynamic 指令时才登记, 与 ASM 的访问次序一致
    let bootstrap_out = match &bootstrap_attr {
        Some(a) => {
            let table = bsm_parse(class, a.off, a.len);
            bsm_begin(table, flags & FLAG_FRESH_POOL != 0, flags & FLAG_BSM_ARGS_FIRST != 0);
            Some(true)
        }
        None => {
            bsm_begin(Vec::new(), flags & FLAG_FRESH_POOL != 0, flags & FLAG_BSM_ARGS_FIRST != 0);
            None
        }
    };
    for m in &methods {
        let new_name = maps.method(&this_name, &m.name, &m.desc);
        let name_i = cp.add_utf8(&new_name);
        if crate::trace_on() {
            crate::trace_push(&format!(
                "M {} -> {} idx={} next={}",
                m.name, new_name, name_i, cp.next
            ));
        }
        let desc_i = cp.add_utf8(&maps.desc(&m.desc));
        let mut sig_i = 0;
        let mut deprecated = false;
        let mut exceptions = Vec::new();
        let slots = param_slots(&m.desc, m.access & 0x0008 != 0);
        let mapped_params: Vec<(u16, String)> = maps
            .params
            .get(&(this_name.clone(), m.name.clone(), m.desc.clone()))
            .map(|list| {
                list.iter()
                    .filter_map(|(i, name)| slots.get(*i as usize).map(|s| (*s, name.clone())))
                    .collect()
            })
            .unwrap_or_default();
        let mut code = None;
        let mut anns = Anns::default();
        let mut param_rv = None;
        let mut param_ri = None;
        let mut default_value = None;
        let mut method_params = None;
        // visitMethod 的参数顺序: name, desc, signature, exceptions
        for a in &m.attrs {
            if cp.utf8_of(a.name_idx) == "Signature" && flags & FLAG_STRIP_SIGS == 0 {
                sig_i = cp.add_utf8(&maps.signature(&cp.utf8_of(u2_at(class, a.off))));
            }
        }
        for a in &m.attrs {
            if cp.utf8_of(a.name_idx) == "Exceptions" {
                let n = u2_at(class, a.off) as usize;
                for k in 0..n {
                    let idx = u2_at(class, a.off + 2 + k * 2);
                    exceptions.push(cp.add_class(&maps.class(&cp.class_name_of(idx))));
                }
            }
        }
        // 按 ASM readMethod 的访问顺序登记: MethodParameters -> AnnotationDefault
        // -> RV/RI 注解 -> RV/RI 类型注解 -> RV/RI 参数注解 -> Code
        let mut mp_off: Option<usize> = None;
        let mut ad_off: Option<usize> = None;
        let mut rv_off: Option<usize> = None;
        let mut ri_off: Option<usize> = None;
        let mut rvt_off: Option<usize> = None;
        let mut rit_off: Option<usize> = None;
        let mut pv_off: Option<usize> = None;
        let mut pi_off: Option<usize> = None;
        let mut code_off: Option<usize> = None;
        for a in &m.attrs {
            match cp.utf8_of(a.name_idx).as_str() {
                "Code" => code_off = Some(a.off),
                "Exceptions" | "Signature" => {}
                "Deprecated" => deprecated = true,
                "Synthetic" => {}
                "MethodParameters" => mp_off = Some(a.off),
                "AnnotationDefault" => ad_off = Some(a.off),
                "RuntimeVisibleAnnotations" => rv_off = Some(a.off),
                "RuntimeInvisibleAnnotations" => ri_off = Some(a.off),
                "RuntimeVisibleTypeAnnotations" => rvt_off = Some(a.off),
                "RuntimeInvisibleTypeAnnotations" => rit_off = Some(a.off),
                "RuntimeVisibleParameterAnnotations" => pv_off = Some(a.off),
                "RuntimeInvisibleParameterAnnotations" => pi_off = Some(a.off),
                other => return Err(format!("未处理的方法属性: {other}")),
            }
        }
        if let Some(off) = mp_off {
            let count = class[off];
            let mut bytes = Vec::with_capacity(1 + 4 * count as usize);
            bytes.push(count);
            for k in 0..count as usize {
                let ni = u2_at(class, off + 1 + k * 4);
                let acc = u2_at(class, off + 3 + k * 4);
                let idx = if ni == 0 { 0 } else { cp.add_utf8(&cp.utf8_of(ni)) };
                bytes.extend_from_slice(&idx.to_be_bytes());
                bytes.extend_from_slice(&acc.to_be_bytes());
            }
            method_params = Some(bytes);
        }
        if let Some(off) = ad_off {
            let mut bytes = Vec::new();
            read_element_value(&mut cp, maps, class, off, &mut bytes)?;
            default_value = Some(bytes);
        }
        if let Some(off) = rv_off {
            anns.rv = read_anns(&mut cp, maps, class, off)?;
        }
        if let Some(off) = ri_off {
            anns.ri = read_anns(&mut cp, maps, class, off)?;
        }
        if let Some(off) = rvt_off {
            anns.rv_type = read_type_anns(&mut cp, maps, class, off)?;
        }
        if let Some(off) = rit_off {
            anns.ri_type = read_type_anns(&mut cp, maps, class, off)?;
        }
        if let Some(off) = pv_off {
            param_rv = Some(read_param_anns(&mut cp, maps, class, off)?);
        }
        if let Some(off) = pi_off {
            param_ri = Some(read_param_anns(&mut cp, maps, class, off)?);
        }
        // 构造函数带合成参数时, 参数注解整体前移(非静态内部类的外部类引用 / 枚举的 name 与 ordinal)
        if m.name == "<init>" && !synth_prefix.is_empty() && desc_starts_with(&m.desc, &synth_prefix) {
            let shift = synth_prefix.len();
            let fix = |p: &mut ParamAnns| {
                let n = p.per.len();
                let mut np: Vec<Vec<Vec<u8>>> = Vec::with_capacity(n);
                for i in 0..n {
                    if i + shift < p.per.len() {
                        np.push(p.per[i + shift].clone());
                    } else {
                        np.push(Vec::new());
                    }
                }
                p.per = np;
            };
            if let Some(v) = param_rv.as_mut() {
                fix(v);
            }
            if let Some(v) = param_ri.as_mut() {
                fix(v);
            }
        }
        // 所有参数都没有注解时 ASM 不创建该属性; ART 0.1.25 仍把属性名留在常量池里
        let all_empty = |p: &ParamAnns| p.per.iter().all(|v| v.is_empty());
        let orphan = flags & FLAG_PARAM_ANN_FIX != 0;
        let mut orphan_rv = false;
        let mut orphan_ri = false;
        if param_rv.as_ref().map(&all_empty).unwrap_or(false) {
            param_rv = None;
            orphan_rv = orphan;
        }
        if param_ri.as_ref().map(&all_empty).unwrap_or(false) {
            param_ri = None;
            orphan_ri = orphan;
        }
        if let Some(off) = code_off {
            code = Some(remap_code(&mut cp, maps, class, off, flags, &mapped_params)?);
        }
        method_out.push(MethodOut {
            access: m.access,
            deprecated,
            name: name_i,
            desc: desc_i,
            sig: sig_i,
            exceptions,
            code,
            anns,
            param_rv,
            param_ri,
            default_value,
            method_params,
            orphan_param_rv: orphan_rv,
            orphan_param_ri: orphan_ri,
        });
    }



    // 非 1.21.x 在访问阶段末尾登记 SourceFile 的值, 1.21.x 推迟到写出阶段
    if flags & FLAG_SRC_FIX != 0 && flags & FLAG_SRC_AT_WRITE == 0 {
        if let Some(name) = &src_name {
            src_idx = Some(cp.add_utf8(name));
        }
    }


    // 写出: 字段 -> 方法 -> 类属性
    let mut tail_bytes = Vec::with_capacity(class.len() + 1024);
    tail_bytes.extend_from_slice(&access.to_be_bytes());
    tail_bytes.extend_from_slice(&this_class.to_be_bytes());
    tail_bytes.extend_from_slice(&super_class.to_be_bytes());
    tail_bytes.extend_from_slice(&(iface_idx.len() as u16).to_be_bytes());
    for x in &iface_idx {
        tail_bytes.extend_from_slice(&x.to_be_bytes());
    }

    tail_bytes.extend_from_slice(&(field_out.len() as u16).to_be_bytes());
    for f in &field_out {
        tail_bytes.extend_from_slice(&f.access.to_be_bytes());
        tail_bytes.extend_from_slice(&f.name.to_be_bytes());
        tail_bytes.extend_from_slice(&f.desc.to_be_bytes());
        let mut n = f.anns.attr_count();
        if f.constant.is_some() { n += 1; }
        if f.sig != 0 { n += 1; }
        if f.deprecated { n += 1; }
        tail_bytes.extend_from_slice(&n.to_be_bytes());
        if let Some(c) = f.constant {
            tail_bytes.extend_from_slice(&cp.add_utf8("ConstantValue").to_be_bytes());
            tail_bytes.extend_from_slice(&2u32.to_be_bytes());
            tail_bytes.extend_from_slice(&c.to_be_bytes());
        }
        if f.sig != 0 {
            tail_bytes.extend_from_slice(&cp.add_utf8("Signature").to_be_bytes());
            tail_bytes.extend_from_slice(&2u32.to_be_bytes());
            tail_bytes.extend_from_slice(&f.sig.to_be_bytes());
        }
        if f.deprecated {
            tail_bytes.extend_from_slice(&cp.add_utf8("Deprecated").to_be_bytes());
            tail_bytes.extend_from_slice(&0u32.to_be_bytes());
        }
        if !f.anns.rv.is_empty() {
            write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeVisibleAnnotations", &f.anns.rv);
        }
        if !f.anns.ri.is_empty() {
            write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeInvisibleAnnotations", &f.anns.ri);
        }
        if !f.anns.rv_type.is_empty() {
            write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeVisibleTypeAnnotations", &f.anns.rv_type);
        }
        if !f.anns.ri_type.is_empty() {
            write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeInvisibleTypeAnnotations", &f.anns.ri_type);
        }
    }

    tail_bytes.extend_from_slice(&(method_out.len() as u16).to_be_bytes());
    for m in &method_out {
        if crate::trace_on() {
            crate::trace_push(&format!("WSTART {} off={}", m.name, tail_bytes.len()));
        }
        tail_bytes.extend_from_slice(&m.access.to_be_bytes());
        tail_bytes.extend_from_slice(&m.name.to_be_bytes());
        tail_bytes.extend_from_slice(&m.desc.to_be_bytes());
        let mut n = m.anns.attr_count();
        if m.code.is_some() { n += 1; }
        if !m.exceptions.is_empty() { n += 1; }
        if m.sig != 0 { n += 1; }
        if m.deprecated { n += 1; }
        if m.param_rv.is_some() { n += 1; }
        if m.param_ri.is_some() { n += 1; }
        if m.default_value.is_some() { n += 1; }
        if m.method_params.is_some() { n += 1; }
        tail_bytes.extend_from_slice(&n.to_be_bytes());
        if let Some(c) = &m.code {
            let code_name = cp.add_utf8("Code");
            let mut body = Vec::with_capacity(c.code.len() + 64);
            body.extend_from_slice(&c.max_stack.to_be_bytes());
            body.extend_from_slice(&c.max_locals.to_be_bytes());
            body.extend_from_slice(&(c.code.len() as u32).to_be_bytes());
            body.extend_from_slice(&c.code);
            body.extend_from_slice(&(c.handlers.len() as u16).to_be_bytes());
            for h in &c.handlers {
                body.extend_from_slice(&h.0.to_be_bytes());
                body.extend_from_slice(&h.1.to_be_bytes());
                body.extend_from_slice(&h.2.to_be_bytes());
                body.extend_from_slice(&h.3.to_be_bytes());
            }
            let mut cn = 0u16;
            if c.smt.is_some() { cn += 1; }
            if c.lnt.is_some() { cn += 1; }
            if c.lvt.is_some() { cn += 1; }
            if c.lvtt.is_some() { cn += 1; }
            if c.rv_type.is_some() { cn += 1; }
            if c.ri_type.is_some() { cn += 1; }
            body.extend_from_slice(&cn.to_be_bytes());
            if let (false, Some(raw)) = (c.layout_changed, &c.smt_raw) {
                let mut bytes = raw.bytes.clone();
                for (pos, name) in &raw.refs {
                    let idx = cp.add_class(name);
                    bytes[*pos] = (idx >> 8) as u8;
                    bytes[*pos + 1] = idx as u8;
                }
                body.extend_from_slice(&cp.add_utf8("StackMapTable").to_be_bytes());
                body.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                body.extend_from_slice(&bytes);
            } else if let Some(frames) = &c.smt {
                let bytes = encode_frames(&mut cp, frames);
                body.extend_from_slice(&cp.add_utf8("StackMapTable").to_be_bytes());
                body.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                body.extend_from_slice(&bytes);
            }
            if let (false, Some(raw)) = (c.layout_changed, &c.lnt_raw) {
                body.extend_from_slice(&cp.add_utf8("LineNumberTable").to_be_bytes());
                body.extend_from_slice(&(raw.len() as u32).to_be_bytes());
                body.extend_from_slice(raw);
            } else if let Some(entries) = &c.lnt {
                body.extend_from_slice(&cp.add_utf8("LineNumberTable").to_be_bytes());
                body.extend_from_slice(&(2 + 4 * entries.len() as u32).to_be_bytes());
                body.extend_from_slice(&(entries.len() as u16).to_be_bytes());
                for (pcv, line) in entries {
                    body.extend_from_slice(&pcv.to_be_bytes());
                    body.extend_from_slice(&line.to_be_bytes());
                }
            }
            if let (false, Some(raw)) = (c.layout_changed, &c.lvt_raw) {
                body.extend_from_slice(&cp.add_utf8("LocalVariableTable").to_be_bytes());
                body.extend_from_slice(&(raw.len() as u32).to_be_bytes());
                body.extend_from_slice(raw);
            } else if let Some(entries) = &c.lvt {
                body.extend_from_slice(&cp.add_utf8("LocalVariableTable").to_be_bytes());
                body.extend_from_slice(&(2 + 10 * entries.len() as u32).to_be_bytes());
                body.extend_from_slice(&(entries.len() as u16).to_be_bytes());
                for e in entries {
                    let ni = cp.add_utf8(&e.name);
                    let di = cp.add_utf8(&e.desc);
                    body.extend_from_slice(&e.start.to_be_bytes());
                    body.extend_from_slice(&e.length.to_be_bytes());
                    body.extend_from_slice(&ni.to_be_bytes());
                    body.extend_from_slice(&di.to_be_bytes());
                    body.extend_from_slice(&e.index.to_be_bytes());
                }
            }
            if let (false, Some(raw)) = (c.layout_changed, &c.lvtt_raw) {
                body.extend_from_slice(&cp.add_utf8("LocalVariableTypeTable").to_be_bytes());
                body.extend_from_slice(&(raw.len() as u32).to_be_bytes());
                body.extend_from_slice(raw);
            } else if let Some(entries) = &c.lvtt {
                body.extend_from_slice(&cp.add_utf8("LocalVariableTypeTable").to_be_bytes());
                body.extend_from_slice(&(2 + 10 * entries.len() as u32).to_be_bytes());
                body.extend_from_slice(&(entries.len() as u16).to_be_bytes());
                for e in entries {
                    let ni = cp.add_utf8(&e.name);
                    let di = cp.add_utf8(&e.desc);
                    body.extend_from_slice(&e.start.to_be_bytes());
                    body.extend_from_slice(&e.length.to_be_bytes());
                    body.extend_from_slice(&ni.to_be_bytes());
                    body.extend_from_slice(&di.to_be_bytes());
                    body.extend_from_slice(&e.index.to_be_bytes());
                }
            }
            if let Some(list) = &c.rv_type {
                write_ann_attr(&mut body, &mut cp, "RuntimeVisibleTypeAnnotations", list);
            }
            if let Some(list) = &c.ri_type {
                write_ann_attr(&mut body, &mut cp, "RuntimeInvisibleTypeAnnotations", list);
            }
            tail_bytes.extend_from_slice(&code_name.to_be_bytes());
            tail_bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
            tail_bytes.extend_from_slice(&body);
            if crate::trace_on() {
                crate::trace_push(&format!(
                    "CODE {} body={} off={}",
                    m.name,
                    body.len(),
                    tail_bytes.len()
                ));
            }
        }
        if !m.exceptions.is_empty() {
            tail_bytes.extend_from_slice(&cp.add_utf8("Exceptions").to_be_bytes());
            tail_bytes.extend_from_slice(&(2 + 2 * m.exceptions.len() as u32).to_be_bytes());
            tail_bytes.extend_from_slice(&(m.exceptions.len() as u16).to_be_bytes());
            for e in &m.exceptions {
                tail_bytes.extend_from_slice(&e.to_be_bytes());
            }
        }
        if m.sig != 0 {
            tail_bytes.extend_from_slice(&cp.add_utf8("Signature").to_be_bytes());
            tail_bytes.extend_from_slice(&2u32.to_be_bytes());
            tail_bytes.extend_from_slice(&m.sig.to_be_bytes());
        }
        if m.deprecated {
            tail_bytes.extend_from_slice(&cp.add_utf8("Deprecated").to_be_bytes());
            tail_bytes.extend_from_slice(&0u32.to_be_bytes());
        }
        if !m.anns.rv.is_empty() {
            write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeVisibleAnnotations", &m.anns.rv);
        }
        if !m.anns.ri.is_empty() {
            write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeInvisibleAnnotations", &m.anns.ri);
        }
        if !m.anns.rv_type.is_empty() {
            write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeVisibleTypeAnnotations", &m.anns.rv_type);
        }
        if !m.anns.ri_type.is_empty() {
            write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeInvisibleTypeAnnotations", &m.anns.ri_type);
        }
        // ASM MethodWriter 的顺序: 类型注解在参数注解之前
        if m.orphan_param_rv {
            cp.add_utf8("RuntimeVisibleParameterAnnotations");
        }
        if m.orphan_param_ri {
            cp.add_utf8("RuntimeInvisibleParameterAnnotations");
        }
        if let Some(p) = &m.param_rv {
            write_param_ann_attr(&mut tail_bytes, &mut cp, "RuntimeVisibleParameterAnnotations", p);
        }
        if let Some(p) = &m.param_ri {
            write_param_ann_attr(&mut tail_bytes, &mut cp, "RuntimeInvisibleParameterAnnotations", p);
        }
        if let Some(d) = &m.default_value {
            tail_bytes.extend_from_slice(&cp.add_utf8("AnnotationDefault").to_be_bytes());
            tail_bytes.extend_from_slice(&(d.len() as u32).to_be_bytes());
            tail_bytes.extend_from_slice(d);
        }
        if let Some(mp) = &m.method_params {
            tail_bytes.extend_from_slice(&cp.add_utf8("MethodParameters").to_be_bytes());
            tail_bytes.extend_from_slice(&(mp.len() as u32).to_be_bytes());
            tail_bytes.extend_from_slice(mp);
        }
    }

    // 类属性: 与 ASM 相同的写出顺序
    let mut class_attr_count = class_anns.attr_count();
    if !inner_idx.is_empty() { class_attr_count += 1; }
    if encl_idx.is_some() { class_attr_count += 1; }
    if sig_idx != 0 { class_attr_count += 1; }
    if src_name.is_some() { class_attr_count += 1; }
    if deprecated { class_attr_count += 1; }
    if bootstrap_out.is_some() { class_attr_count += 1; }
    if nest_host_idx.is_some() { class_attr_count += 1; }
    if !nest_member_idx.is_empty() { class_attr_count += 1; }
    if !permitted_idx.is_empty() { class_attr_count += 1; }
    if has_record_attr { class_attr_count += 1; }
    tail_bytes.extend_from_slice(&class_attr_count.to_be_bytes());

    if !inner_idx.is_empty() {
        tail_bytes.extend_from_slice(&cp.add_utf8("InnerClasses").to_be_bytes());
        tail_bytes.extend_from_slice(&(2 + 8 * inner_idx.len() as u32).to_be_bytes());
        tail_bytes.extend_from_slice(&(inner_idx.len() as u16).to_be_bytes());
        for (a, b, c, d) in &inner_idx {
            tail_bytes.extend_from_slice(&a.to_be_bytes());
            tail_bytes.extend_from_slice(&b.to_be_bytes());
            tail_bytes.extend_from_slice(&c.to_be_bytes());
            tail_bytes.extend_from_slice(&d.to_be_bytes());
        }
    }
    if let Some((ci, nt)) = encl_idx {
        tail_bytes.extend_from_slice(&cp.add_utf8("EnclosingMethod").to_be_bytes());
        tail_bytes.extend_from_slice(&4u32.to_be_bytes());
        tail_bytes.extend_from_slice(&ci.to_be_bytes());
        tail_bytes.extend_from_slice(&nt.to_be_bytes());
    }
    if sig_idx != 0 {
        tail_bytes.extend_from_slice(&cp.add_utf8("Signature").to_be_bytes());
        tail_bytes.extend_from_slice(&2u32.to_be_bytes());
        tail_bytes.extend_from_slice(&sig_idx.to_be_bytes());
    }
    let mut src_val_off: Option<usize> = None;
    if src_name.is_some() || src_idx.is_some() {
        let nidx = cp.add_utf8("SourceFile");
        tail_bytes.extend_from_slice(&nidx.to_be_bytes());
        tail_bytes.extend_from_slice(&2u32.to_be_bytes());
        match src_idx {
            Some(i) => tail_bytes.extend_from_slice(&i.to_be_bytes()),
            None => {
                if flags & FLAG_SRC_AT_WRITE != 0 {
                    // 取值推迟到类属性全部写完之后再入池
                    src_val_off = Some(tail_bytes.len());
                    tail_bytes.extend_from_slice(&0u16.to_be_bytes());
                } else {
                    let v = cp.add_utf8(src_name.as_deref().unwrap_or(""));
                    tail_bytes.extend_from_slice(&v.to_be_bytes());
                }
            }
        }
    }
    if deprecated {
        tail_bytes.extend_from_slice(&cp.add_utf8("Deprecated").to_be_bytes());
        tail_bytes.extend_from_slice(&0u32.to_be_bytes());
    }
    if !class_anns.rv.is_empty() {
        write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeVisibleAnnotations", &class_anns.rv);
    }
    if !class_anns.ri.is_empty() {
        write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeInvisibleAnnotations", &class_anns.ri);
    }
    if !class_anns.rv_type.is_empty() {
        write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeVisibleTypeAnnotations", &class_anns.rv_type);
    }
    if !class_anns.ri_type.is_empty() {
        write_ann_attr(&mut tail_bytes, &mut cp, "RuntimeInvisibleTypeAnnotations", &class_anns.ri_type);
    }
    if bootstrap_out.is_some() {
        let b = bsm_body(&mut cp, maps)?;
        tail_bytes.extend_from_slice(&cp.add_utf8("BootstrapMethods").to_be_bytes());
        tail_bytes.extend_from_slice(&(b.len() as u32).to_be_bytes());
        tail_bytes.extend_from_slice(&b);
    }
    if let Some(h) = nest_host_idx {
        tail_bytes.extend_from_slice(&cp.add_utf8("NestHost").to_be_bytes());
        tail_bytes.extend_from_slice(&2u32.to_be_bytes());
        tail_bytes.extend_from_slice(&h.to_be_bytes());
    }
    if !nest_member_idx.is_empty() {
        tail_bytes.extend_from_slice(&cp.add_utf8("NestMembers").to_be_bytes());
        tail_bytes.extend_from_slice(&(2 + 2 * nest_member_idx.len() as u32).to_be_bytes());
        tail_bytes.extend_from_slice(&(nest_member_idx.len() as u16).to_be_bytes());
        for x in &nest_member_idx {
            tail_bytes.extend_from_slice(&x.to_be_bytes());
        }
    }
    if !permitted_idx.is_empty() {
        tail_bytes.extend_from_slice(&cp.add_utf8("PermittedSubclasses").to_be_bytes());
        tail_bytes.extend_from_slice(&(2 + 2 * permitted_idx.len() as u32).to_be_bytes());
        tail_bytes.extend_from_slice(&(permitted_idx.len() as u16).to_be_bytes());
        for x in &permitted_idx {
            tail_bytes.extend_from_slice(&x.to_be_bytes());
        }
    }
    if has_record_attr {
        let mut body = Vec::new();
        body.extend_from_slice(&(record_comps.len() as u16).to_be_bytes());
        for c in &record_comps {
            body.extend_from_slice(&c.name.to_be_bytes());
            body.extend_from_slice(&c.desc.to_be_bytes());
            let mut n = c.anns.attr_count();
            if c.sig != 0 {
                n += 1;
            }
            body.extend_from_slice(&n.to_be_bytes());
            if c.sig != 0 {
                body.extend_from_slice(&cp.add_utf8("Signature").to_be_bytes());
                body.extend_from_slice(&2u32.to_be_bytes());
                body.extend_from_slice(&c.sig.to_be_bytes());
            }
            if !c.anns.rv.is_empty() {
                write_ann_attr(&mut body, &mut cp, "RuntimeVisibleAnnotations", &c.anns.rv);
            }
            if !c.anns.ri.is_empty() {
                write_ann_attr(&mut body, &mut cp, "RuntimeInvisibleAnnotations", &c.anns.ri);
            }
            if !c.anns.rv_type.is_empty() {
                write_ann_attr(&mut body, &mut cp, "RuntimeVisibleTypeAnnotations", &c.anns.rv_type);
            }
            if !c.anns.ri_type.is_empty() {
                write_ann_attr(&mut body, &mut cp, "RuntimeInvisibleTypeAnnotations", &c.anns.ri_type);
            }
        }
        tail_bytes.extend_from_slice(&cp.add_utf8("Record").to_be_bytes());
        tail_bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
        tail_bytes.extend_from_slice(&body);
    }

    // 常量池在写出阶段仍可能追加条目, 因此先写完整结构, 最后再拼常量池
    let mut out = Vec::with_capacity(tail_bytes.len() + 4096);
    out.extend_from_slice(&class[0..8]);
    if let Some(off) = src_val_off {
        let v = cp.add_utf8(src_name.as_deref().unwrap_or(""));
        tail_bytes[off] = (v >> 8) as u8;
        tail_bytes[off + 1] = v as u8;
    }

    cp.emit(&mut out);
    out.extend_from_slice(&tail_bytes);
    Ok(out)
}

// 常量与 Code

fn remap_constant(cp: &mut Cp, maps: &Maps, idx: u16) -> Result<u16, String> {
    let e = cp.entries.get(idx as usize).cloned().flatten();
    match e {
        Some(e) if e.tag == 3 || e.tag == 4 => Ok(cp.add_literal(e.tag, e.a as u64)),
        Some(e) if e.tag == 5 || e.tag == 6 => {
            let bits = ((e.a as u64) << 32) | e.b as u64;
            Ok(cp.add_literal(e.tag, bits))
        }
        Some(e) if e.tag == 8 => Ok(cp.add_string(&cp.utf8_of(e.a as u16))),
        Some(e) if e.tag == 7 => Ok(cp.add_class(&maps.class(&cp.class_name_of(idx)))),
        Some(e) if e.tag == 16 => {
            let d = cp.utf8_of(e.a as u16);
            Ok(cp.add_method_type(&maps.desc(&d)))
        }
        Some(e) if e.tag == 15 => remap_method_handle(cp, maps, idx),
        Some(e) if e.tag == 18 => {
            let bsm_old = e.a as u16;
            let bsm = bsm_resolve(cp, maps, bsm_old)?;
            let (n, d) = cp.nat_of(e.b as u16);
            if crate::trace_on() {
                crate::trace_push(&format!(
                    "INDY bsm_old={} sam={:?} name={} desc={}",
                    bsm_old,
                    lambda_sam_desc(bsm_old),
                    n,
                    d
                ));
            }
            let mapped_name = match lambda_sam_desc(bsm_old) {
                Some(sam) => match return_owner(&d) {
                    Some(owner) => {
                        // 函数式接口方法的入池键描述符可能与 SAM 擦除后的描述符不同, 允许按名字兜底
                        let by_desc = maps.method(&owner, &n, &sam);
                        if by_desc == n {
                            maps.method_by_name(&owner, &n).unwrap_or(by_desc)
                        } else {
                            by_desc
                        }
                    }
                    None => n.clone(),
                },
                None => n.clone(),
            };
            Ok(cp.add_invoke_dynamic(bsm, &mapped_name, &maps.desc(&d)))
        }
        _ => Err(format!(
            "不支持的常量类型: {idx} tag={}",
            cp.entries.get(idx as usize).and_then(|e| e.as_ref()).map(|x| x.tag).unwrap_or(0)
        )),
    }
}

fn remap_method_handle(cp: &mut Cp, maps: &Maps, idx: u16) -> Result<u16, String> {
    let e = cp.entries[idx as usize].as_ref().cloned().ok_or("MethodHandle 缺失")?;
    let kind = e.a as u8;
    let (tag, owner, name, desc) = member_ref(cp, e.b as u16)?;
    let new_name = if tag == 9 {
        maps.field(&owner, &name, &desc)
    } else {
        maps.method(&owner, &name, &desc)
    };
    Ok(cp.add_method_handle(kind, tag, &maps.class(&owner), &new_name, &maps.desc(&desc)))
}

fn member_ref(cp: &Cp, idx: u16) -> Result<(u8, String, String, String), String> {
    let e = cp.entries[idx as usize].as_ref().ok_or("引用常量缺失")?;
    if !(e.tag == 9 || e.tag == 10 || e.tag == 11) {
        return Err("不是成员引用".into());
    }
    Ok((e.tag, cp.class_name_of(e.a as u16), cp.nat_of(e.b as u16).0, cp.nat_of(e.b as u16).1))
}

// ASM Remapper.mapInnerClassName: 取映射后类名最后一个 '$' 之后的部分, 跳过前导数字
fn inner_simple_name(mapped: &str, original: &str) -> String {
    if let Some(mut idx) = mapped.rfind('$') {
        idx += 1;
        while idx < mapped.len() && mapped.as_bytes()[idx].is_ascii_digit() {
            idx += 1;
        }
        mapped[idx..].to_string()
    } else {
        original.to_string()
    }
}

fn return_owner(desc: &str) -> Option<String> {
    let close = desc.rfind(')')?;
    let ret = &desc[close + 1..];
    if ret.starts_with('L') && ret.ends_with(';') {
        Some(ret[1..ret.len() - 1].to_string())
    } else {
        None
    }
}


// 解析 StackMapTable, 返回 (相对偏移, 该帧的对象类型索引)
fn scan_smt_types(class: &[u8], off: usize, len: usize) -> Vec<(u16, Vec<u16>)> {
    let body = &class[off..off + len];
    if body.len() < 2 {
        return Vec::new();
    }
    let n = u16::from_be_bytes([body[0], body[1]]) as usize;
    let mut p = 2usize;
    let mut out: Vec<(u16, Vec<u16>)> = Vec::with_capacity(n);
    let mut prev: u32 = 0;
    let mut rd_vti = |body: &[u8], p: &mut usize, names: &mut Vec<u16>| -> bool {
        if *p >= body.len() {
            return false;
        }
        let tag = body[*p];
        *p += 1;
        match tag {
            7 => {
                if *p + 2 > body.len() {
                    return false;
                }
                let ci = u16::from_be_bytes([body[*p], body[*p + 1]]);
                names.push(ci);
                *p += 2;
                true
            }
            8 => {
                *p += 2;
                true
            }
            _ => true,
        }
    };
    for i in 0..n {
        if p >= body.len() {
            break;
        }
        let ft = body[p];
        p += 1;
        let mut names: Vec<u16> = Vec::new();
        let delta: u32;
        match ft {
            0..=63 => {
                delta = ft as u32;
            }
            64..=127 => {
                delta = (ft - 64) as u32;
                rd_vti(body, &mut p, &mut names);
            }
            247 => {
                if p + 2 > body.len() { break; }
                delta = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
                p += 2;
                rd_vti(body, &mut p, &mut names);
            }
            248..=251 => {
                if p + 2 > body.len() { break; }
                delta = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
                p += 2;
            }
            252..=254 => {
                if p + 2 > body.len() { break; }
                delta = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
                p += 2;
                for _ in 0..(ft - 251) {
                    if !rd_vti(body, &mut p, &mut names) { break; }
                }
            }
            255 => {
                if p + 2 > body.len() { break; }
                delta = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
                p += 2;
                if p + 2 > body.len() { break; }
                let nl = u16::from_be_bytes([body[p], body[p + 1]]) as usize;
                p += 2;
                for _ in 0..nl { if !rd_vti(body, &mut p, &mut names) { break; } }
                if p + 2 > body.len() { break; }
                let ns = u16::from_be_bytes([body[p], body[p + 1]]) as usize;
                p += 2;
                for _ in 0..ns { if !rd_vti(body, &mut p, &mut names) { break; } }
            }
            _ => break,
        }
        let abs = if i == 0 { delta } else { prev + delta + 1 };
        prev = abs;
        out.push((abs as u16, names));
    }
    out
}

fn remap_code(
    cp: &mut Cp,
    maps: &Maps,
    class: &[u8],
    off: usize,
    flags: u32,
    params: &[(u16, String)],
) -> Result<CodeOut, String> {
    let mut r = Reader { b: class, p: off };
    let max_stack = r.u2();
    let max_locals = r.u2();
    let code_len = r.u4() as usize;
    let code_off = r.p;
    let code = &class[code_off..code_off + code_len];

    // ASM 先访问 try-catch 再走指令, 异常捕获类型先入池
    let et_off = code_off + code_len;
    let et_len = u2_at(class, et_off) as usize;
    for k in 0..et_len {
        let ct = u2_at(class, et_off + 2 + k * 8 + 6);
        if ct != 0 {
            let n = maps.class(&cp.class_name_of(ct));
            cp.add_class(&n);
        }
    }

    // 第一遍: 改写常量、确定每条指令的新长度、建立 旧偏移 -> 新偏移 映射
    struct Insn {
        old_pc: usize,
        new_pc: usize,
        op: u8,
        old_len: usize,
        new_len: usize,
        cp_idx: Option<u16>,
        switch_body: Option<usize>,
    }
    // StackMapTable 的对象类型在 visitFrame 时入池, 按指令位置交错登记
    let mut frames_at: Vec<(u16, Vec<u16>)> = Vec::new();
    {
        let et = code_off + code_len;
        let exc = u2_at(class, et) as usize;
        let mut q = et + 2 + 8 * exc;
        let ac = u2_at(class, q) as usize;
        q += 2;
        for _ in 0..ac {
            let ni = u2_at(class, q);
            let alen = u32::from_be_bytes([class[q+2], class[q+3], class[q+4], class[q+5]]) as usize;
            if cp.utf8_of(ni) == "StackMapTable" {
                frames_at = scan_smt_types(class, q + 6, alen);
            }
            q += 6 + alen;
        }
    }
    let mut frame_i = 0usize;
    let mut insns: Vec<Insn> = Vec::new();
    let mut map: Vec<(usize, usize)> = Vec::new();
    let mut new_pc = 0usize;
    let mut pc = 0usize;
    while pc < code_len {
        while frame_i < frames_at.len() && (frames_at[frame_i].0 as usize) <= pc {
            for ci in &frames_at[frame_i].1 {
                let nm = cp.class_name_of(*ci);
                let mapped = maps.class(&nm);
                cp.add_class(&mapped);
            }
            frame_i += 1;
        }
        let op = code[pc];
        let (len, refs) = insn_info(&code[pc..], op, pc)?;
        let mut cp_idx = None;
        for (rel, kind) in refs {
            let at = pc + rel;
            if kind == RefKind::Literal8 {
                let old = code[at] as u16;
                cp_idx = Some(remap_constant(cp, maps, old)?);
                continue;
            }
            let old = u16::from_be_bytes([code[at], code[at + 1]]);
            let new = match kind {
                RefKind::Class => cp.add_class(&maps.class(&cp.class_name_of(old))),
                RefKind::Member => {
                    let (tag, owner, name, desc) = member_ref(cp, old)?;
                    let n = if tag == 9 {
                        maps.field(&owner, &name, &desc)
                    } else {
                        maps.method(&owner, &name, &desc)
                    };
                    cp.add_ref(tag, &maps.class(&owner), &n, &maps.desc(&desc))
                }
                RefKind::Literal | RefKind::InvokeDynamic => remap_constant(cp, maps, old)?,
                RefKind::Literal8 => unreachable!(),
            };
            cp_idx = Some(new);
        }

        let (mut new_len, mut switch_body) = (len, None);
        if op == 0x12 {
            if let Some(ix) = cp_idx {
                if ix > 255 {
                    new_len = 3;
                }
            }
        } else if op == 0x13 {
            if let Some(ix) = cp_idx {
                if ix <= 255 {
                    new_len = 2;
                }
            }
        } else if op == 0xaa || op == 0xab {
            let q = 1 + (4 - ((pc + 1) % 4)) % 4;
            let body = len - q;
            let pad = (4 - ((new_pc + 1) % 4)) % 4;
            new_len = 1 + pad + body;
            switch_body = Some(body);
        }
        map.push((pc, new_pc));
        insns.push(Insn { old_pc: pc, new_pc, op, old_len: len, new_len, cp_idx, switch_body });
        new_pc += new_len;
        pc += len;
    }
    map.push((code_len, new_pc));
    let map_of = |old: usize| -> usize {
        match map.binary_search_by_key(&old, |e| e.0) {
            Ok(k) => map[k].1,
            Err(k) => {
                if k == 0 {
                    0
                } else {
                    map[k - 1].1 + (old - map[k - 1].0)
                }
            }
        }
    };

    // 布局未变时沿用原始字节
    // 只有 ldc 跨过 255 边界才重排, switch 的 padding 随之变化
    let layout_changed = insns.iter().any(|i| {
        (i.op == 0x12 || i.op == 0x13) && i.cp_idx.map(|x| x > 255) != Some(i.op == 0x13)
    });
    let mut out_code = Vec::with_capacity(new_pc);
    for ins in insns.iter() {
        let base = ins.old_pc;
        let op = ins.op;
        // 长度未变的指令沿用原字节, 只就地改写常量池操作数
        // 方法内有指令长度变化时, 跳转/switch 的相对偏移必须重算
        let is_branch = matches!(op, 0x99..=0xa8 | 0xc6 | 0xc7 | 0xc8 | 0xc9 | 0xaa | 0xab);
        if ins.new_len == ins.old_len && !(layout_changed && is_branch) {
            let start = out_code.len();
            out_code.extend_from_slice(&code[base..base + ins.old_len]);
            if let Some(ix) = ins.cp_idx {
                if op == 0x12 {
                    out_code[start + 1] = ix as u8;
                } else {
                    out_code[start + 1] = (ix >> 8) as u8;
                    out_code[start + 2] = ix as u8;
                }
            }
            continue;
        }
        match op {
            0x12 => {
                let ix = ins.cp_idx.unwrap_or(0);
                if ix > 255 {
                    out_code.push(0x13);
                    out_code.extend_from_slice(&ix.to_be_bytes());
                } else {
                    out_code.push(0x12);
                    out_code.push(ix as u8);
                }
            }
            0x13 => {
                let ix = ins.cp_idx.unwrap_or(0);
                if ix <= 255 {
                    out_code.push(0x12);
                    out_code.push(ix as u8);
                } else {
                    out_code.push(0x13);
                    out_code.extend_from_slice(&ix.to_be_bytes());
                }
            }
            0x14 => {
                out_code.push(0x14);
                out_code.extend_from_slice(&ins.cp_idx.unwrap_or(0).to_be_bytes());
            }
            0x99..=0xa8 | 0xc6 | 0xc7 => {
                out_code.push(op);
                let off = i16::from_be_bytes([code[base + 1], code[base + 2]]) as i64;
                let target = (base as i64 + off) as usize;
                let delta = map_of(target) as i64 - ins.new_pc as i64;
                if delta < i16::MIN as i64 || delta > i16::MAX as i64 {
                    return Err("分支偏移超出 i16".into());
                }
                out_code.extend_from_slice(&(delta as i16).to_be_bytes());
            }
            0xc8 | 0xc9 => {
                out_code.push(op);
                let off = i32::from_be_bytes([code[base + 1], code[base + 2], code[base + 3], code[base + 4]]) as i64;
                let target = (base as i64 + off) as usize;
                let delta = map_of(target) as i64 - ins.new_pc as i64;
                out_code.extend_from_slice(&(delta as i32).to_be_bytes());
            }
            0xaa => {
                out_code.push(0xaa);
                while out_code.len() % 4 != 0 {
                    out_code.push(0);
                }
                let q = 1 + (4 - ((base + 1) % 4)) % 4;
                let default = i32::from_be_bytes([code[base + q], code[base + q + 1], code[base + q + 2], code[base + q + 3]]) as i64;
                let low = i32::from_be_bytes([code[base + q + 4], code[base + q + 5], code[base + q + 6], code[base + q + 7]]);
                let high = i32::from_be_bytes([code[base + q + 8], code[base + q + 9], code[base + q + 10], code[base + q + 11]]);
                let d = map_of((base as i64 + default) as usize) as i64 - ins.new_pc as i64;
                out_code.extend_from_slice(&(d as i32).to_be_bytes());
                out_code.extend_from_slice(&low.to_be_bytes());
                out_code.extend_from_slice(&high.to_be_bytes());
                let n = (high - low + 1) as usize;
                for k in 0..n {
                    let e = base + q + 12 + k * 4;
                    let o = i32::from_be_bytes([code[e], code[e + 1], code[e + 2], code[e + 3]]) as i64;
                    let nd = map_of((base as i64 + o) as usize) as i64 - ins.new_pc as i64;
                    out_code.extend_from_slice(&(nd as i32).to_be_bytes());
                }
            }
            0xab => {
                out_code.push(0xab);
                while out_code.len() % 4 != 0 {
                    out_code.push(0);
                }
                let q = 1 + (4 - ((base + 1) % 4)) % 4;
                let default = i32::from_be_bytes([code[base + q], code[base + q + 1], code[base + q + 2], code[base + q + 3]]) as i64;
                let npairs = i32::from_be_bytes([code[base + q + 4], code[base + q + 5], code[base + q + 6], code[base + q + 7]]) as usize;
                let d = map_of((base as i64 + default) as usize) as i64 - ins.new_pc as i64;
                out_code.extend_from_slice(&(d as i32).to_be_bytes());
                out_code.extend_from_slice(&(npairs as i32).to_be_bytes());
                for k in 0..npairs {
                    let e = base + q + 8 + k * 8;
                    out_code.extend_from_slice(&code[e..e + 4]);
                    let o = i32::from_be_bytes([code[e + 4], code[e + 5], code[e + 6], code[e + 7]]) as i64;
                    let nd = map_of((base as i64 + o) as usize) as i64 - ins.new_pc as i64;
                    out_code.extend_from_slice(&(nd as i32).to_be_bytes());
                }
            }
            0x15..=0x19 | 0x36..=0x3a | 0xa9 => {
                out_code.extend_from_slice(&code[base..base + 2]);
            }
            0xb2..=0xb8 | 0xbb | 0xbd | 0xc0 | 0xc1 => {
                out_code.push(op);
                out_code.extend_from_slice(&ins.cp_idx.unwrap_or(0).to_be_bytes());
            }
            0xb9 => {
                out_code.push(0xb9);
                out_code.extend_from_slice(&ins.cp_idx.unwrap_or(0).to_be_bytes());
                out_code.push(code[base + 3]);
                out_code.push(0);
            }
            0xba => {
                out_code.push(0xba);
                out_code.extend_from_slice(&ins.cp_idx.unwrap_or(0).to_be_bytes());
                out_code.push(0);
                out_code.push(0);
            }
            0xc5 => {
                out_code.push(0xc5);
                out_code.extend_from_slice(&ins.cp_idx.unwrap_or(0).to_be_bytes());
                out_code.push(code[base + 3]);
            }
            _ => out_code.extend_from_slice(&code[base..base + ins.old_len]),
        }
    }
    if out_code.len() != new_pc {
        return Err(format!("代码长度计算不一致: {} != {}", out_code.len(), new_pc));
    }

    r.p = code_off + code_len;
    let exc = r.u2() as usize;
    let mut handlers = Vec::with_capacity(exc);
    for _ in 0..exc {
        let st = r.u2();
        let en = r.u2();
        let hd = r.u2();
        let ct = r.u2();
        let nct = if ct == 0 {
            0
        } else {
            cp.add_class(&maps.class(&cp.class_name_of(ct)))
        };
        handlers.push((
            map_of(st as usize) as u16,
            map_of(en as usize) as u16,
            map_of(hd as usize) as u16,
            nct,
        ));
    }
    let ac = r.u2() as usize;
    let mut smt = None;
    let mut smt_raw = None;
    let mut lnt: Option<Vec<(u16, u16)>> = None;
    let mut lnt_raw = None;
    let mut lvt = None;
    let mut lvt_raw = None;
    let mut lvtt = None;
    let mut lvtt_raw = None;
    let mut rv_type = None;
    let mut ri_type = None;
    let mut lvt_loc: Option<(usize, usize)> = None;
    let mut lvtt_loc: Option<(usize, usize)> = None;
    let mut rv_type_loc: Option<usize> = None;
    let mut ri_type_loc: Option<usize> = None;
    for _ in 0..ac {
        let name_idx = r.u2();
        let len = r.u4() as usize;
        let boff = r.p;
        match cp.utf8_of(name_idx).as_str() {
            "StackMapTable" => {
                let (frames, refs) = read_frames(cp, maps, class, boff, len)?;
                smt_raw = Some(SmtOut { bytes: class[boff..boff + len].to_vec(), refs });
                // 帧的绝对偏移要跟随新的代码布局
                smt = Some(
                    frames
                        .into_iter()
                        .map(|mut f| {
                            f.offset = map_of(f.offset as usize) as u16;
                            for v in f.locals.iter_mut().chain(f.stack.iter_mut()) {
                                if let Vti::Uninit(pc) = v {
                                    *pc = map_of(*pc as usize) as u16;
                                }
                            }
                            f
                        })
                        .collect(),
                );
            }
            "LineNumberTable" => {
                let n = u2_at(class, boff) as usize;
                let mut v = Vec::with_capacity(n);
                for k in 0..n {
                    let pcv = u2_at(class, boff + 2 + k * 4);
                    let line = u2_at(class, boff + 4 + k * 4);
                    v.push((map_of(pcv as usize) as u16, line));
                }
                lnt = Some(v);
                lnt_raw = Some(class[boff..boff + len].to_vec());
            }
            "LocalVariableTable" => lvt_loc = Some((boff, len)),
            "LocalVariableTypeTable" => lvtt_loc = Some((boff, len)),
            "RuntimeVisibleTypeAnnotations" => rv_type_loc = Some(boff),
            "RuntimeInvisibleTypeAnnotations" => ri_type_loc = Some(boff),
            other => return Err(format!("未处理的 Code 子属性: {other}")),
        }
        r.p = boff + len;
    }
    // MethodWriter.visitLocalVariable 按 name -> signature(LVTT) -> name -> descriptor(LVT) 登记, 两张表合并处理
    // ASM 按 (start_pc, index) 配对 LVT 与 LVTT, 取第一处匹配
    let mut sig_map: HashMap<(u16, u16), String> = HashMap::new();
    if let Some((boff, len)) = lvtt_loc {
        let body = &class[boff..boff + len];
        let n = u16::from_be_bytes([body[0], body[1]]) as usize;
        for k in 0..n {
            let q = 2 + k * 10;
            let start = u16::from_be_bytes([body[q], body[q + 1]]);
            let length = u16::from_be_bytes([body[q + 2], body[q + 3]]);
            let index = u16::from_be_bytes([body[q + 8], body[q + 9]]);
            let sig_i = u16::from_be_bytes([body[q + 6], body[q + 7]]);
            sig_map.entry((start, index)).or_insert_with(|| maps.signature(&cp.utf8_of(sig_i)));
        }
    }
    if let Some((boff, len)) = lvt_loc {
        let (e, b) = read_lvt(cp, maps, class, boff, len, flags, params, false, Some(&sig_map))?;
        lvt = Some(e);
        lvt_raw = Some(b);
    }
    if let Some((boff, len)) = lvtt_loc {
        let (e, b) = read_lvt(cp, maps, class, boff, len, flags, params, true, None)?;
        lvtt = Some(e);
        lvtt_raw = Some(b);
    }
    // ASM 在局部变量之后才访问 Code 级类型注解
    if let Some(off) = rv_type_loc {
        rv_type = Some(read_type_anns_map(cp, maps, class, off, Some(&map))?);
    }
    if let Some(off) = ri_type_loc {
        ri_type = Some(read_type_anns_map(cp, maps, class, off, Some(&map))?);
    }
    // 局部变量表的偏移也要跟随代码布局
    let fix = |entries: &mut Vec<LvtEntry>| {
        for e in entries.iter_mut() {
            let s = map_of(e.start as usize) as u16;
            let end = map_of(e.start as usize + e.length as usize) as u16;
            e.start = s;
            e.length = end - s;
        }
    };
    if let Some(v) = lvt.as_mut() {
        fix(v);
    }
    if let Some(v) = lvtt.as_mut() {
        fix(v);
    }

    Ok(CodeOut {
        max_stack,
        max_locals,
        code: out_code,
        handlers,
        smt,
        smt_raw,
        lnt,
        lnt_raw,
        lvt,
        lvt_raw,
        lvtt,
        lvtt_raw,
        layout_changed,
        rv_type,
        ri_type,
    })
}



#[derive(Clone, PartialEq)]
enum Vti {
    Top,
    Int,
    Float,
    Double,
    Long,
    Null,
    UninitThis,
    Object(String),
    ObjectIdx(u16),
    Uninit(u16),
}

struct Frame {
    offset: u16,
    kind: u8,
    locals: Vec<Vti>,
    stack: Vec<Vti>,
}

fn read_frames(cp: &mut Cp, maps: &Maps, class: &[u8], off: usize, len: usize) -> Result<(Vec<Frame>, Vec<(usize, String)>), String> {
    let body = &class[off..off + len];
    let n = u16::from_be_bytes([body[0], body[1]]) as usize;
    let mut p = 2usize;
    let mut frames: Vec<Frame> = Vec::with_capacity(n);
    let mut refs: Vec<(usize, String)> = Vec::new();
    let mut prev_locals: Vec<Vti> = Vec::new();
    let mut abs: u32 = 0;
    for _ in 0..n {
        let ft = body[p];
        p += 1;
        let (delta, locals, stack) = if ft <= 63 {
            (ft as u32, prev_locals.clone(), Vec::new())
        } else if ft <= 127 {
            let v = read_vti(cp, maps, body, &mut p, &mut refs)?;
            (ft as u32 - 64, prev_locals.clone(), vec![v])
        } else if ft == 247 {
            let d = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
            p += 2;
            let v = read_vti(cp, maps, body, &mut p, &mut refs)?;
            (d, prev_locals.clone(), vec![v])
        } else if ft >= 248 && ft <= 250 {
            let d = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
            p += 2;
            let k = 251 - ft as usize;
            let mut l = prev_locals.clone();
            l.truncate(l.len().saturating_sub(k));
            (d, l, Vec::new())
        } else if ft == 251 {
            let d = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
            p += 2;
            (d, prev_locals.clone(), Vec::new())
        } else if ft >= 252 && ft <= 254 {
            let d = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
            p += 2;
            let k = ft as usize - 251;
            let mut l = prev_locals.clone();
            for _ in 0..k {
                l.push(read_vti(cp, maps, body, &mut p, &mut refs)?);
            }
            (d, l, Vec::new())
        } else if ft == 255 {
            let d = u16::from_be_bytes([body[p], body[p + 1]]) as u32;
            p += 2;
            let nl = u16::from_be_bytes([body[p], body[p + 1]]) as usize;
            p += 2;
            let mut l = Vec::with_capacity(nl);
            for _ in 0..nl {
                l.push(read_vti(cp, maps, body, &mut p, &mut refs)?);
            }
            let ns = u16::from_be_bytes([body[p], body[p + 1]]) as usize;
            p += 2;
            let mut st = Vec::with_capacity(ns);
            for _ in 0..ns {
                st.push(read_vti(cp, maps, body, &mut p, &mut refs)?);
            }
            (d, l, st)
        } else {
            return Err(format!("未知 stack map frame {ft}"));
        };
        abs += delta + if frames.is_empty() { 0 } else { 1 };
        prev_locals = locals.clone();
        frames.push(Frame { offset: abs as u16, kind: ft, locals, stack });
    }
    Ok((frames, refs))
}

fn read_vti(
    cp: &mut Cp,
    maps: &Maps,
    body: &[u8],
    p: &mut usize,
    refs: &mut Vec<(usize, String)>,
) -> Result<Vti, String> {
    let tag = body[*p];
    *p += 1;
    Ok(match tag {
        0 => Vti::Top,
        1 => Vti::Int,
        2 => Vti::Float,
        3 => Vti::Double,
        4 => Vti::Long,
        5 => Vti::Null,
        6 => Vti::UninitThis,
        7 => {
            // ASM 在 visitFrame 时就登记帧里的对象类型
            let name = maps.class(&cp.class_name_of(u16::from_be_bytes([body[*p], body[*p + 1]])));
            let idx = cp.add_class(&name);
            refs.push((*p, name));
            *p += 2;
            Vti::ObjectIdx(idx)
        }
        8 => {
            let o = u16::from_be_bytes([body[*p], body[*p + 1]]);
            *p += 2;
            Vti::Uninit(o)
        }
        other => return Err(format!("未知 verification type {other}")),
    })
}

fn encode_frames(cp: &mut Cp, frames: &[Frame]) -> Vec<u8> {
    let mut out = Vec::with_capacity(frames.len() * 4 + 8);
    out.extend_from_slice(&(frames.len() as u16).to_be_bytes());
    let mut prev_off: u32 = 0;
    for (i, f) in frames.iter().enumerate() {
        let delta = f.offset as u32 - prev_off - if i == 0 { 0 } else { 1 };
        let k = f.kind;
        // 尽量沿用原来的帧类型, 只有 delta 超出编码范围才升级
        if k <= 63 {
            if delta <= 63 {
                out.push(delta as u8);
            } else {
                out.push(251);
                out.extend_from_slice(&(delta as u16).to_be_bytes());
            }
        } else if k <= 127 {
            if delta <= 63 {
                out.push(64 + delta as u8);
            } else {
                out.push(247);
                out.extend_from_slice(&(delta as u16).to_be_bytes());
            }
            write_vti(&mut out, cp, &f.stack[0]);
        } else if k == 247 {
            out.push(247);
            out.extend_from_slice(&(delta as u16).to_be_bytes());
            write_vti(&mut out, cp, &f.stack[0]);
        } else if (248..=251).contains(&k) {
            out.push(k);
            out.extend_from_slice(&(delta as u16).to_be_bytes());
        } else if (252..=254).contains(&k) {
            out.push(k);
            out.extend_from_slice(&(delta as u16).to_be_bytes());
            let n = (k - 251) as usize;
            let start = f.locals.len().saturating_sub(n);
            for v in &f.locals[start..] {
                write_vti(&mut out, cp, v);
            }
        } else {
            out.push(255);
            out.extend_from_slice(&(delta as u16).to_be_bytes());
            out.extend_from_slice(&(f.locals.len() as u16).to_be_bytes());
            for v in &f.locals {
                write_vti(&mut out, cp, v);
            }
            out.extend_from_slice(&(f.stack.len() as u16).to_be_bytes());
            for v in &f.stack {
                write_vti(&mut out, cp, v);
            }
        }
        prev_off = f.offset as u32;
    }
    out
}

fn write_vti(out: &mut Vec<u8>, cp: &mut Cp, v: &Vti) {
    match v {
        Vti::Top => out.push(0),
        Vti::Int => out.push(1),
        Vti::Float => out.push(2),
        Vti::Double => out.push(3),
        Vti::Long => out.push(4),
        Vti::Null => out.push(5),
        Vti::UninitThis => out.push(6),
        Vti::Object(name) => {
            out.push(7);
            let idx = cp.add_class(name);
            out.extend_from_slice(&idx.to_be_bytes());
        }
        Vti::ObjectIdx(idx) => {
            out.push(7);
            out.extend_from_slice(&idx.to_be_bytes());
        }
        Vti::Uninit(o) => {
            out.push(8);
            out.extend_from_slice(&o.to_be_bytes());
        }
    }
}

fn read_lvt(
    cp: &mut Cp,
    maps: &Maps,
    class: &[u8],
    off: usize,
    len: usize,
    flags: u32,
    params: &[(u16, String)],
    as_type: bool,
    sig_map: Option<&HashMap<(u16, u16), String>>,
) -> Result<(Vec<LvtEntry>, Vec<u8>), String> {
    let body = &class[off..off + len];
    let mut bytes = Vec::with_capacity(len);
    bytes.extend_from_slice(&body[0..2]);
    let n = u16::from_be_bytes([body[0], body[1]]) as usize;
    let mut out = Vec::with_capacity(n);
    let mut p = 2usize;
    let mut seen: HashMap<u16, u32> = HashMap::new();
    for _ in 0..n {
        let start = u16::from_be_bytes([body[p], body[p + 1]]);
        let length = u16::from_be_bytes([body[p + 2], body[p + 3]]);
        let name_i = u16::from_be_bytes([body[p + 4], body[p + 5]]);
        let desc_i = u16::from_be_bytes([body[p + 6], body[p + 7]]);
        let index = u16::from_be_bytes([body[p + 8], body[p + 9]]);
        p += 10;
        let mut name = cp.utf8_of(name_i);
        if let Some((_, mapped)) = params.iter().find(|(slot, _)| *slot == index) {
            name = mapped.clone();
        } else if flags & FLAG_IDS_FIX != 0 && !valid_java_ident(&name) {
            let c = seen.entry(index).or_insert(0);
            *c += 1;
            name = format!("lvt_{index}_{c}_");
        }
        let desc = if as_type {
            maps.signature(&cp.utf8_of(desc_i))
        } else {
            maps.desc(&cp.utf8_of(desc_i))
        };
        // MethodWriter.visitLocalVariable: 有签名时先登记 name + signature(LVTT), 再 name + descriptor(LVT)
        let sig = sig_map.and_then(|m| m.get(&(start, index)).cloned());
        let ni = cp.add_utf8(&name);
        if let Some(sig) = &sig {
            cp.add_utf8(sig);
        }
        if sig.is_some() {
            cp.add_utf8(&name);
        }
        let di = cp.add_utf8(&desc);
        bytes.extend_from_slice(&start.to_be_bytes());
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(&ni.to_be_bytes());
        bytes.extend_from_slice(&di.to_be_bytes());
        bytes.extend_from_slice(&index.to_be_bytes());
        out.push(LvtEntry { start, length, name, desc, index });
    }
    Ok((out, bytes))
}

fn param_slots(desc: &str, is_static: bool) -> Vec<u16> {
    let b = desc.as_bytes();
    let mut slots = Vec::new();
    let mut slot: u16 = if is_static { 0 } else { 1 };
    let mut i = 1usize;
    while i < b.len() && b[i] != b')' {
        let start = slot;
        match b[i] {
            b'L' => {
                while i < b.len() && b[i] != b';' {
                    i += 1;
                }
                i += 1;
                slot += 1;
            }
            b'[' => {
                while i < b.len() && b[i] == b'[' {
                    i += 1;
                }
                if i < b.len() && b[i] == b'L' {
                    while i < b.len() && b[i] != b';' {
                        i += 1;
                    }
                }
                i += 1;
                slot += 1;
            }
            b'J' | b'D' => {
                i += 1;
                slot += 2;
            }
            _ => {
                i += 1;
                slot += 1;
            }
        }
        slots.push(start);
    }
    slots
}

fn valid_java_ident(s: &str) -> bool {
    let mut ch = s.chars();
    match ch.next() {
        Some(c) if c.is_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

fn scan_lambda_bsm(cp: &Cp, class: &[u8], off: usize, len: usize) -> Vec<Option<String>> {
    let body = &class[off..off + len];
    let n = u16::from_be_bytes([body[0], body[1]]) as usize;
    let mut out = Vec::with_capacity(n);
    let mut p = 2usize;
    for _ in 0..n {
        let mh = u16::from_be_bytes([body[p], body[p + 1]]);
        let argc = u16::from_be_bytes([body[p + 2], body[p + 3]]) as usize;
        p += 4;
        let args_start = p;
        p += 2 * argc;
        let mut sam = None;
        if let Some(e) = cp.entries.get(mh as usize).and_then(|x| x.as_ref()) {
            if e.tag == 15 {
                if let Some((tag, owner, name, _)) = cp.member_of(e.b as u16) {
                    if tag == 10
                        && owner == "java/lang/invoke/LambdaMetafactory"
                        && (name == "metafactory" || name == "altMetafactory")
                        && argc > 0
                    {
                        let a0 = u16::from_be_bytes([body[args_start], body[args_start + 1]]);
                        if let Some(t) = cp.entries.get(a0 as usize).and_then(|x| x.as_ref()) {
                            if t.tag == 16 {
                                sam = Some(cp.utf8_of(t.a as u16));
                            }
                        }
                    }
                }
            }
        }
        out.push(sam);
    }
    out
}

#[derive(Clone)]
struct BsmEntry {
    mh: u16,
    args: Vec<u16>,
}

static mut INHERIT_METHODS: bool = true;

pub fn inherit_methods() -> bool {
    unsafe { INHERIT_METHODS }
}

pub fn set_inherit_methods(v: bool) {
    unsafe { INHERIT_METHODS = v };
}

static mut BSM_TABLE: Option<Vec<BsmEntry>> = None;
static mut BSM_OUT: Option<Vec<(u16, Vec<u16>)>> = None;
static mut BSM_MAP: Option<std::collections::HashMap<u16, u16>> = None;
// 新建常量池时 BootstrapMethods 由 indy 常量的登记顺序重新生成, 不保留原表
static mut BSM_FRESH: bool = false;
static mut BSM_ARGS_FIRST: bool = false;

fn bsm_parse(class: &[u8], off: usize, len: usize) -> Vec<BsmEntry> {
    let body = &class[off..off + len];
    let n = u16::from_be_bytes([body[0], body[1]]) as usize;
    let mut p = 2usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let mh = u16::from_be_bytes([body[p], body[p + 1]]);
        let argc = u16::from_be_bytes([body[p + 2], body[p + 3]]) as usize;
        p += 4;
        let mut args = Vec::with_capacity(argc);
        for _ in 0..argc {
            args.push(u16::from_be_bytes([body[p], body[p + 1]]));
            p += 2;
        }
        out.push(BsmEntry { mh, args });
    }
    out
}

fn bsm_begin(table: Vec<BsmEntry>, fresh: bool, args_first: bool) {
    unsafe {
        BSM_OUT = Some(Vec::new());
        BSM_MAP = Some(std::collections::HashMap::new());
        BSM_FRESH = fresh;
        BSM_ARGS_FIRST = args_first;
        BSM_TABLE = Some(table);
    }
}

// 原表条目原样保留; 重命名后内容有变化的引导方法追加到表尾, invokedynamic 指向新条目
fn bsm_resolve(cp: &mut Cp, maps: &Maps, old: u16) -> Result<u16, String> {
    if let Some(&n) = unsafe { BSM_MAP.as_ref().and_then(|m| m.get(&old)) } {
        return Ok(n);
    }
    if unsafe { BSM_FRESH } {
        let e = unsafe { BSM_TABLE.as_ref().and_then(|t| t.get(old as usize)).cloned() }
            .ok_or_else(|| format!("引导方法索引越界: {old}"))?;
        let args_first = unsafe { BSM_ARGS_FIRST };
        let mut args = Vec::with_capacity(e.args.len());
        let nmh;
        if args_first {
            for a in &e.args {
                args.push(remap_constant(cp, maps, *a)?);
            }
            nmh = remap_method_handle(cp, maps, e.mh)?;
        } else {
            nmh = remap_method_handle(cp, maps, e.mh)?;
            for a in &e.args {
                args.push(remap_constant(cp, maps, *a)?);
            }
        }
        let n = unsafe {
            let out = BSM_OUT.as_mut().unwrap();
            match out.iter().position(|x| *x == (nmh, args.clone())) {
                Some(k) => k as u16,
                None => {
                    out.push((nmh, args));
                    (out.len() - 1) as u16
                }
            }
        };
        unsafe {
            if let Some(m) = BSM_MAP.as_mut() {
                m.insert(old, n);
            }
        }
        return Ok(n);
    }
    let e = unsafe { BSM_TABLE.as_ref().and_then(|t| t.get(old as usize)).cloned() };
    let e = match e {
        Some(e) => e,
        None => return Err(format!("引导方法索引越界: {old}")),
    };
    let args_first = unsafe { BSM_ARGS_FIRST };
    let mut args = Vec::with_capacity(e.args.len());
    let nmh;
    if args_first {
        for a in &e.args {
            args.push(remap_constant(cp, maps, *a)?);
        }
        nmh = remap_method_handle(cp, maps, e.mh)?;
    } else {
        nmh = remap_method_handle(cp, maps, e.mh)?;
        for a in &e.args {
            args.push(remap_constant(cp, maps, *a)?);
        }
    }
    let base = unsafe { BSM_TABLE.as_ref().map(|t| t.len()).unwrap_or(0) } as u16;
    let unchanged = nmh == e.mh && args == e.args;
    let n = if unchanged {
        old
    } else {
        let idx = unsafe {
            let out = BSM_OUT.as_mut().unwrap();
            match out.iter().position(|x| *x == (nmh, args.clone())) {
                Some(k) => base + k as u16,
                None => {
                    out.push((nmh, args.clone()));
                    base + (out.len() - 1) as u16
                }
            }
        };
        idx
    };
    unsafe {
        if let Some(m) = BSM_MAP.as_mut() {
            m.insert(old, n);
        }
    }
    Ok(n)
}

fn bsm_body(cp: &mut Cp, maps: &Maps) -> Result<Vec<u8>, String> {
    let _ = (cp, maps);
    let fresh = unsafe { BSM_FRESH };
    let orig = if fresh {
        Vec::new()
    } else {
        unsafe { BSM_TABLE.as_ref().cloned().unwrap_or_default() }
    };
    let extra = unsafe { BSM_OUT.as_ref().cloned().unwrap_or_default() };
    let total = orig.len() + extra.len();
    let mut out = Vec::with_capacity(total * 8 + 2);
    out.extend_from_slice(&(total as u16).to_be_bytes());
    for e in orig.iter() {
        out.extend_from_slice(&e.mh.to_be_bytes());
        out.extend_from_slice(&(e.args.len() as u16).to_be_bytes());
        for a in &e.args {
            out.extend_from_slice(&a.to_be_bytes());
        }
    }
    for (mh, args) in extra.iter() {
        out.extend_from_slice(&mh.to_be_bytes());
        out.extend_from_slice(&(args.len() as u16).to_be_bytes());
        for a in args {
            out.extend_from_slice(&a.to_be_bytes());
        }
    }
    Ok(out)
}

fn remap_bootstrap(cp: &mut Cp, maps: &Maps, class: &[u8], off: usize, len: usize) -> Result<Vec<u8>, String> {
    let body = &class[off..off + len];
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(&body[0..2]);
    let n = u16::from_be_bytes([body[0], body[1]]) as usize;
    let mut p = 2usize;
    for _ in 0..n {
        let mh = u16::from_be_bytes([body[p], body[p + 1]]);
        let nmh = remap_method_handle(cp, maps, mh)?;
        out.extend_from_slice(&nmh.to_be_bytes());
        let argc = u16::from_be_bytes([body[p + 2], body[p + 3]]) as usize;
        out.extend_from_slice(&body[p + 2..p + 4]);
        p += 4;
        for _ in 0..argc {
            let ci = u16::from_be_bytes([body[p], body[p + 1]]);
            let nci = remap_constant(cp, maps, ci)?;
            out.extend_from_slice(&nci.to_be_bytes());
            p += 2;
        }
    }
    Ok(out)
}

#[derive(PartialEq)]
enum RefKind {
    Class,
    Member,
    Literal,
    Literal8,
    InvokeDynamic,
}

// 返回指令长度与 (相对偏移, 需改写的常量池类型)
fn insn_info(code: &[u8], op: u8, pc: usize) -> Result<(usize, Vec<(usize, RefKind)>), String> {
    let mut refs = Vec::new();
    let len = match op {
        0x00..=0x0f => 1,
        0x10 => 2,
        0x11 => 3,
        0x12 => {
            refs.push((1, RefKind::Literal8));
            2
        }
        0x13 | 0x14 => {
            refs.push((1, RefKind::Literal));
            3
        }
        0x15..=0x19 => 2,
        0x1a..=0x35 => 1,
        0x36..=0x3a => 2,
        0x3b..=0x83 => 1,
        0x84 => 3,
        0x85..=0x98 => 1,
        0x99..=0xa8 => 3,
        0xa9 => 2,
        0xaa => {
            let q = 1 + (4 - ((pc + 1) % 4)) % 4;
            let low = i32::from_be_bytes([code[q + 4], code[q + 5], code[q + 6], code[q + 7]]);
            let high = i32::from_be_bytes([code[q + 8], code[q + 9], code[q + 10], code[q + 11]]);
            q + 12 + 4 * (high - low + 1) as usize
        }
        0xab => {
            let q = 1 + (4 - ((pc + 1) % 4)) % 4;
            let npairs = i32::from_be_bytes([code[q + 4], code[q + 5], code[q + 6], code[q + 7]]);
            q + 8 + 8 * npairs as usize
        }
        0xac..=0xb1 => 1,
        0xb2..=0xb8 => {
            refs.push((1, RefKind::Member));
            3
        }
        0xb9 => {
            refs.push((1, RefKind::Member));
            5
        }
        0xba => {
            refs.push((1, RefKind::InvokeDynamic));
            5
        }
        0xbb => {
            refs.push((1, RefKind::Class));
            3
        }
        0xbc => 2,
        0xbd => {
            refs.push((1, RefKind::Class));
            3
        }
        0xbe | 0xbf => 1,
        0xc0 | 0xc1 => {
            refs.push((1, RefKind::Class));
            3
        }
        0xc2 | 0xc3 => 1,
        0xc4 => {
            if code[1] == 0x84 {
                6
            } else {
                4
            }
        }
        0xc5 => {
            refs.push((1, RefKind::Class));
            4
        }
        0xc6 | 0xc7 => 3,
        0xc8 | 0xc9 => 5,
        0xca => 1,
        0xfe | 0xff => 1,
        _ => return Err(format!("未知指令 {op:02x}")),
    };
    Ok((len, refs))
}
