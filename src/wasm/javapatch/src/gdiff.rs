// GDIFF 增量还原: 与 javaxdelta 2.0.1 的 GDiffWriter/GDiffPatcher 完全一致的命令集
// 文件头为 d1 ff d1 ff 04, 之后是变长命令, 0x00 结束; 没有源/目标长度字段
// 1..246 直接数据, 247/248 为带 2/4 字节长度的数据, 249..255 为 (偏移,长度) 复制命令

pub const MAGIC: [u8; 5] = [0xd1, 0xff, 0xd1, 0xff, 0x04];

const DATA_MAX: u8 = 246;
const DATA_USHORT: u8 = 247;
const DATA_INT: u8 = 248;
const COPY_USHORT_UBYTE: u8 = 249;
const COPY_USHORT_USHORT: u8 = 250;
const COPY_USHORT_INT: u8 = 251;
const COPY_INT_UBYTE: u8 = 252;
const COPY_INT_USHORT: u8 = 253;
const COPY_INT_INT: u8 = 254;
const COPY_LONG_INT: u8 = 255;

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, String> {
        if self.pos >= self.buf.len() {
            return Err("GDIFF 补丁数据提前结束".into());
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(b)
    }

    fn u16(&mut self) -> Result<usize, String> {
        let a = self.u8()? as usize;
        let b = self.u8()? as usize;
        Ok((a << 8) | b)
    }

    fn u32(&mut self) -> Result<u32, String> {
        let mut v = 0u32;
        for _ in 0..4 {
            v = (v << 8) | self.u8()? as u32;
        }
        Ok(v)
    }

    fn u64(&mut self) -> Result<u64, String> {
        let mut v = 0u64;
        for _ in 0..8 {
            v = (v << 8) | self.u8()? as u64;
        }
        Ok(v)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.buf.len() - self.pos {
            return Err("GDIFF 补丁数据提前结束".into());
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
}

pub fn apply(base: &[u8], delta: &[u8]) -> Result<Vec<u8>, String> {
    if delta.len() < MAGIC.len() {
        return Err("GDIFF 补丁过短".into());
    }
    if delta[..MAGIC.len()] != MAGIC {
        return Err("GDIFF 补丁头不匹配".into());
    }
    let mut r = Reader {
        buf: delta,
        pos: MAGIC.len(),
    };
    let mut out: Vec<u8> = Vec::with_capacity(base.len() + delta.len());
    loop {
        let cmd = r.u8()?;
        match cmd {
            0 => break,
            1..=DATA_MAX => {
                let data = r.take(cmd as usize)?;
                out.extend_from_slice(data);
            }
            DATA_USHORT => {
                let n = r.u16()?;
                let data = r.take(n)?;
                out.extend_from_slice(data);
            }
            DATA_INT => {
                let n = r.u32()? as usize;
                let data = r.take(n)?;
                out.extend_from_slice(data);
            }
            _ => {
                let (offset, length) = match cmd {
                    COPY_USHORT_UBYTE => (r.u16()? as u64, r.u8()? as usize),
                    COPY_USHORT_USHORT => (r.u16()? as u64, r.u16()?),
                    COPY_USHORT_INT => (r.u16()? as u64, r.u32()? as usize),
                    COPY_INT_UBYTE => (r.u32()? as u64, r.u8()? as usize),
                    COPY_INT_USHORT => (r.u32()? as u64, r.u16()?),
                    COPY_INT_INT => (r.u32()? as u64, r.u32()? as usize),
                    COPY_LONG_INT => (r.u64()?, r.u32()? as usize),
                    _ => return Err(format!("GDIFF 未知命令: {cmd}")),
                };
                let end = offset
                    .checked_add(length as u64)
                    .ok_or_else(|| "GDIFF 复制长度溢出".to_string())?;
                if end > base.len() as u64 {
                    return Err(format!(
                        "GDIFF 复制越界: 偏移 {offset} 长度 {length} 超出源 {} 字节",
                        base.len()
                    ));
                }
                out.extend_from_slice(&base[offset as usize..end as usize]);
            }
        }
    }
    Ok(out)
}

pub fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for chunk in data.chunks(5552) {
        for &byte in chunk {
            a += byte as u32;
            b += a;
        }
        a %= MOD;
        b %= MOD;
    }
    (b << 16) | a
}
