// LZMA 解码器: 只读 .lzma 容器(13 字节头: 1 字节属性 + 4 字节字典 + 8 字节原始长度)
// 与 lzma-java / org.tukaani.xz 的 LZMAInputStream 读取的旧式 LZMA 流一致, 不处理 XZ 容器

const PROB_INIT: u16 = 1024;
const NUM_STATES: usize = 12;
const NUM_POS_STATES_MAX: usize = 16;
const NUM_LEN_TO_POS_STATES: usize = 4;
const MATCH_MIN_LEN: u32 = 2;
const NUM_ALIGN_BITS: u32 = 4;
const ALIGN_TABLE_SIZE: usize = 1 << NUM_ALIGN_BITS;
const START_POS_MODEL_INDEX: u32 = 4;
const END_POS_MODEL_INDEX: u32 = 14;
const NUM_FULL_DISTANCES: usize = 1 << (END_POS_MODEL_INDEX >> 1);
const NUM_LOW_LEN_SYMBOLS: usize = 8;
const NUM_MID_LEN_SYMBOLS: usize = 8;
const NUM_LOW_LEN_BITS: u32 = 3;
const NUM_MID_LEN_BITS: u32 = 3;
const NUM_HIGH_LEN_BITS: u32 = 8;

const STATE_UPDATE_CHAR: [usize; 12] = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 4, 5];
const STATE_UPDATE_MATCH: [usize; 12] = [7, 7, 7, 7, 7, 7, 7, 10, 10, 10, 10, 10];
const STATE_UPDATE_REP: [usize; 12] = [8, 8, 8, 8, 8, 8, 8, 11, 11, 11, 11, 11];
const STATE_UPDATE_SHORT_REP: [usize; 12] = [9, 9, 9, 9, 9, 9, 9, 11, 11, 11, 11, 11];

const K_TOP_VALUE: u32 = 1 << 24;

struct RangeDecoder<'a> {
    data: &'a [u8],
    pos: usize,
    range: u32,
    code: u32,
}

impl<'a> RangeDecoder<'a> {
    fn new(data: &'a [u8]) -> Result<Self, String> {
        if data.len() < 5 {
            return Err("LZMA 流不足 5 字节".into());
        }
        if data[0] != 0 {
            return Err("LZMA 范围编码器首字节必须为 0".into());
        }
        let mut code = 0u32;
        for i in 0..4 {
            code = (code << 8) | data[1 + i] as u32;
        }
        Ok(RangeDecoder {
            data,
            pos: 5,
            range: 0xFFFF_FFFF,
            code,
        })
    }

    fn next_byte(&mut self) -> u8 {
        let b = if self.pos < self.data.len() {
            self.data[self.pos]
        } else {
            0
        };
        self.pos += 1;
        b
    }

    fn decode_bit(&mut self, prob: &mut u16) -> u32 {
        let bound = (self.range >> 11) * (*prob as u32);
        let bit;
        if self.code < bound {
            self.range = bound;
            *prob += (2048 - *prob) >> 5;
            bit = 0;
        } else {
            self.range -= bound;
            self.code -= bound;
            *prob -= *prob >> 5;
            bit = 1;
        }
        if self.range < K_TOP_VALUE {
            self.range <<= 8;
            self.code = (self.code << 8) | self.next_byte() as u32;
        }
        bit
    }

    fn decode_direct_bits(&mut self, num_bits: u32) -> u32 {
        let mut result = 0u32;
        for _ in 0..num_bits {
            self.range >>= 1;
            self.code = self.code.wrapping_sub(self.range);
            let t = 0u32.wrapping_sub(self.code >> 31);
            self.code = self.code.wrapping_add(self.range & t);
            result = (result << 1).wrapping_add(t.wrapping_add(1));
            if self.range < K_TOP_VALUE {
                self.range <<= 8;
                self.code = (self.code << 8) | self.next_byte() as u32;
            }
        }
        result
    }

    // 位树: 高位先出
    fn decode_bit_tree(&mut self, probs: &mut [u16], num_bits: u32) -> u32 {
        let mut m = 1usize;
        for _ in 0..num_bits {
            let bit = self.decode_bit(&mut probs[m]) as usize;
            m = (m << 1) | bit;
        }
        (m - (1usize << num_bits)) as u32
    }

    // 反向位树: 低位先出; start 允许为 -1, 与 7-Zip/ASM 的 posDecoders 起始约定一致
    fn decode_bit_tree_reverse_at(
        &mut self,
        probs: &mut [u16],
        start: isize,
        num_bits: u32,
    ) -> u32 {
        let mut m: isize = 1;
        let mut symbol = 0u32;
        for i in 0..num_bits {
            let idx = start + m;
            let bit = self.decode_bit(&mut probs[idx as usize]) as u32;
            m = (m << 1) | bit as isize;
            symbol |= bit << i;
        }
        symbol
    }

    fn decode_bit_tree_reverse(&mut self, probs: &mut [u16], num_bits: u32) -> u32 {
        self.decode_bit_tree_reverse_at(probs, 0, num_bits)
    }
}

struct LenDecoder {
    choice: u16,
    choice2: u16,
    low: [[u16; NUM_LOW_LEN_SYMBOLS]; NUM_POS_STATES_MAX],
    mid: [[u16; NUM_MID_LEN_SYMBOLS]; NUM_POS_STATES_MAX],
    high: [u16; 1 << NUM_HIGH_LEN_BITS],
}

impl LenDecoder {
    fn new() -> Self {
        LenDecoder {
            choice: PROB_INIT,
            choice2: PROB_INIT,
            low: [[PROB_INIT; NUM_LOW_LEN_SYMBOLS]; NUM_POS_STATES_MAX],
            mid: [[PROB_INIT; NUM_MID_LEN_SYMBOLS]; NUM_POS_STATES_MAX],
            high: [PROB_INIT; 1 << NUM_HIGH_LEN_BITS],
        }
    }

    fn decode(&mut self, rc: &mut RangeDecoder, pos_state: usize) -> u32 {
        if rc.decode_bit(&mut self.choice) == 0 {
            rc.decode_bit_tree(&mut self.low[pos_state], NUM_LOW_LEN_BITS)
        } else if rc.decode_bit(&mut self.choice2) == 0 {
            NUM_LOW_LEN_SYMBOLS as u32
                + rc.decode_bit_tree(&mut self.mid[pos_state], NUM_MID_LEN_BITS)
        } else {
            (NUM_LOW_LEN_SYMBOLS + NUM_MID_LEN_SYMBOLS) as u32
                + rc.decode_bit_tree(&mut self.high, NUM_HIGH_LEN_BITS)
        }
    }
}

pub fn decode(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() < 13 {
        return Err("LZMA 文件头不足 13 字节".into());
    }
    let props = input[0] as u32;
    if props >= 9 * 5 * 5 {
        return Err("LZMA 属性字节非法".into());
    }
    let lc = (props % 9) as usize;
    let lp = ((props / 9) % 5) as usize;
    let pb = (props / 45) as usize;
    let dict_size = u32::from_le_bytes([input[1], input[2], input[3], input[4]]) as usize;
    let out_size = u64::from_le_bytes([
        input[5], input[6], input[7], input[8], input[9], input[10], input[11], input[12],
    ]);
    let known_size = out_size != u64::MAX;

    let mut rc = RangeDecoder::new(&input[13..])?;

    let mut is_match = [PROB_INIT; NUM_STATES * NUM_POS_STATES_MAX];
    let mut is_rep = [PROB_INIT; NUM_STATES];
    let mut is_rep_g0 = [PROB_INIT; NUM_STATES];
    let mut is_rep_g1 = [PROB_INIT; NUM_STATES];
    let mut is_rep_g2 = [PROB_INIT; NUM_STATES];
    let mut is_rep0_long = [PROB_INIT; NUM_STATES * NUM_POS_STATES_MAX];
    let mut pos_slot = [[PROB_INIT; 1 << 6]; NUM_LEN_TO_POS_STATES];
    let mut pos_decoders = [PROB_INIT; NUM_FULL_DISTANCES - END_POS_MODEL_INDEX as usize];
    let mut pos_align = [PROB_INIT; ALIGN_TABLE_SIZE];
    let mut len_dec = LenDecoder::new();
    let mut rep_len_dec = LenDecoder::new();
    let mut literal = vec![PROB_INIT; 0x300usize << (lc + lp)];

    let mut out: Vec<u8> = Vec::with_capacity(if known_size {
        out_size as usize
    } else {
        1 << 23
    });
    let mut state = 0usize;
    let mut rep0: u32 = 0;
    let mut rep1: u32 = 0;
    let mut rep2: u32 = 0;
    let mut rep3: u32 = 0;
    let pb_mask = (1usize << pb) - 1;
    let lp_mask = (1usize << lp) - 1;

    loop {
        if known_size && out.len() as u64 == out_size {
            break;
        }
        let pos_state = out.len() & pb_mask;
        let state_pos = state * NUM_POS_STATES_MAX + pos_state;

        if rc.decode_bit(&mut is_match[state_pos]) == 0 {
            // 字面量
            let prev_byte = if out.is_empty() {
                0u8
            } else {
                out[out.len() - 1]
            };
            let lit_state = ((out.len() & lp_mask) << lc) + ((prev_byte as usize) >> (8 - lc));
            let probs = &mut literal[0x300 * lit_state..0x300 * (lit_state + 1)];
            let symbol: u32;
            if state >= 7 {
                let mut match_byte = out[out.len() - 1 - rep0 as usize] as u32;
                let mut m = 1usize;
                loop {
                    let match_bit = ((match_byte >> 7) & 1) as usize;
                    match_byte <<= 1;
                    let idx = ((1 + match_bit) << 8) + m;
                    let bit = rc.decode_bit(&mut probs[idx]) as usize;
                    m = (m << 1) | bit;
                    if match_bit != bit {
                        while m < 0x100 {
                            let b = rc.decode_bit(&mut probs[m]) as usize;
                            m = (m << 1) | b;
                        }
                        break;
                    }
                    if m >= 0x100 {
                        break;
                    }
                }
                symbol = m as u32;
            } else {
                let mut m = 1usize;
                while m < 0x100 {
                    let bit = rc.decode_bit(&mut probs[m]) as usize;
                    m = (m << 1) | bit;
                }
                symbol = m as u32;
            }
            out.push((symbol & 0xFF) as u8);
            state = STATE_UPDATE_CHAR[state];
            continue;
        }

        let len: u32;
        if rc.decode_bit(&mut is_rep[state]) == 0 {
            // 普通匹配: 先把 rep 栈右移, rep0 稍后被新距离覆盖
            rep3 = rep2;
            rep2 = rep1;
            rep1 = rep0;
            len = len_dec.decode(&mut rc, pos_state);
            state = STATE_UPDATE_MATCH[state];
            let len_to_pos_state = (len as usize).min(NUM_LEN_TO_POS_STATES - 1);
            let slot = rc.decode_bit_tree(&mut pos_slot[len_to_pos_state], 6);
            if slot < START_POS_MODEL_INDEX {
                rep0 = slot;
            } else {
                let num_direct_bits = (slot >> 1) - 1;
                rep0 = (2 | (slot & 1)) << num_direct_bits;
                if slot < END_POS_MODEL_INDEX {
                    let start = rep0 as isize - slot as isize - 1;
                    let symbol =
                        rc.decode_bit_tree_reverse_at(&mut pos_decoders, start, num_direct_bits);
                    rep0 += symbol;
                } else {
                    rep0 +=
                        rc.decode_direct_bits(num_direct_bits - NUM_ALIGN_BITS) << NUM_ALIGN_BITS;
                    rep0 += rc.decode_bit_tree_reverse(&mut pos_align, NUM_ALIGN_BITS);
                    if rep0 == 0xFFFF_FFFF {
                        if known_size {
                            return Err("LZMA 流出现结束标记, 但与声明长度不符".into());
                        }
                        break;
                    }
                }
            }
            let full_len = len + MATCH_MIN_LEN;
            copy_match(&mut out, rep0, full_len)?;
        } else {
            // 重复匹配
            if rc.decode_bit(&mut is_rep_g0[state]) == 0 {
                if rc.decode_bit(&mut is_rep0_long[state_pos]) == 0 {
                    state = STATE_UPDATE_SHORT_REP[state];
                    copy_match(&mut out, rep0, 1)?;
                    continue;
                }
            } else {
                let dist;
                if rc.decode_bit(&mut is_rep_g1[state]) == 0 {
                    dist = rep1;
                } else {
                    if rc.decode_bit(&mut is_rep_g2[state]) == 0 {
                        dist = rep2;
                    } else {
                        dist = rep3;
                        rep3 = rep2;
                    }
                    rep2 = rep1;
                }
                rep1 = rep0;
                rep0 = dist;
            }
            state = STATE_UPDATE_REP[state];
            let l = rep_len_dec.decode(&mut rc, pos_state);
            copy_match(&mut out, rep0, l + MATCH_MIN_LEN)?;
        }
    }

    // 字典大小只影响解码器内存分配策略, 输出长度已由流本身决定
    let _ = dict_size;
    Ok(out)
}

fn copy_match(out: &mut Vec<u8>, dist: u32, len: u32) -> Result<(), String> {
    if dist as usize >= out.len() {
        return Err(format!(
            "LZMA 复制距离越界: 距离 {} 已输出 {}",
            dist,
            out.len()
        ));
    }
    let start = out.len() - dist as usize - 1;
    for i in 0..len as usize {
        let b = out[start + i];
        out.push(b);
    }
    Ok(())
}
