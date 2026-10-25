// WASM 导出层: 输入/输出都通过线性内存传递
// alloc/free 由 JS 侧管理输入缓冲, 计算结果放在模块内部的 RESULT 缓冲,
// JS 通过 result_ptr/result_len 读取; 出错时函数返回负值, 并可通过 error_* 取错误文本

pub mod classrewrite;
mod gdiff;
mod lzma;

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};
use std::cell::RefCell;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ERROR: RefCell<String> = const { RefCell::new(String::new()) };
    static MAPS: RefCell<Option<classrewrite::Maps>> = const { RefCell::new(None) };
}

fn set_error(msg: impl Into<String>) {
    ERROR.with(|e| *e.borrow_mut() = msg.into());
}

fn set_result(bytes: Vec<u8>) {
    RESULT.with(|r| *r.borrow_mut() = bytes);
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::from_size_align(len, 8).unwrap();
    unsafe { raw_alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = Layout::from_size_align(len, 8).unwrap();
    unsafe { raw_dealloc(ptr, layout) }
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}

#[no_mangle]
pub extern "C" fn error_ptr() -> *const u8 {
    ERROR.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn error_len() -> usize {
    ERROR.with(|e| e.borrow().len())
}

unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

fn finish(result: Result<Vec<u8>, String>) -> i32 {
    match result {
        Ok(bytes) => {
            let n = bytes.len() as i32;
            set_result(bytes);
            n
        }
        Err(msg) => {
            set_error(msg);
            -1
        }
    }
}

/// 解压 .lzma 容器, 返回结果长度; 失败返回 -1
#[no_mangle]
pub extern "C" fn lzma_decode(src: *const u8, len: usize) -> i32 {
    let data = unsafe { slice(src, len) };
    finish(lzma::decode(data))
}

/// 应用 GDIFF 增量补丁, 返回结果长度; 失败返回 -1
#[no_mangle]
pub extern "C" fn gdiff_apply(
    base: *const u8,
    base_len: usize,
    delta: *const u8,
    delta_len: usize,
) -> i32 {
    let base = unsafe { slice(base, base_len) };
    let delta = unsafe { slice(delta, delta_len) };
    finish(gdiff::apply(base, delta))
}

/// Adler32 校验值, 与 java.util.zip.Adler32 相同
#[no_mangle]
pub extern "C" fn adler32(ptr: *const u8, len: usize) -> u32 {
    gdiff::adler32(unsafe { slice(ptr, len) })
}

static mut CRC_TABLE: [u32; 256] = [0; 256];
static mut CRC_READY: bool = false;

fn crc_table() -> &'static [u32; 256] {
    unsafe {
        if !CRC_READY {
            for i in 0..256u32 {
                let mut c = i;
                for _ in 0..8 {
                    c = if c & 1 != 0 {
                        0xEDB8_8320 ^ (c >> 1)
                    } else {
                        c >> 1
                    };
                }
                CRC_TABLE[i as usize] = c;
            }
            CRC_READY = true;
        }
        &CRC_TABLE
    }
}

/// CRC-32/IEEE, 与 java.util.zip.CRC32 相同
#[no_mangle]
pub extern "C" fn crc32(ptr: *const u8, len: usize, seed: u32) -> u32 {
    let table = crc_table();
    let data = unsafe { slice(ptr, len) };
    let mut c = !seed;
    for &b in data {
        c = table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

// 原生测试/工具入口, wasm 侧不使用
pub fn lzma_decode_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    lzma::decode(input)
}
pub fn gdiff_apply_bytes(base: &[u8], delta: &[u8]) -> Result<Vec<u8>, String> {
    gdiff::apply(base, delta)
}

pub fn adler32_bytes(input: &[u8]) -> u32 {
    gdiff::adler32(input)
}

/// 载入映射表(二进制格式见 classrewrite::Maps::parse), 成功返回 0
#[no_mangle]
pub extern "C" fn maps_init(ptr: *const u8, len: usize) -> i32 {
    let data = unsafe { slice(ptr, len) };
    match classrewrite::Maps::parse(data) {
        Ok(m) => {
            MAPS.with(|slot| *slot.borrow_mut() = Some(m));
            0
        }
        Err(msg) => {
            set_error(msg);
            -1
        }
    }
}

/// 释放映射表
#[no_mangle]
pub extern "C" fn maps_free() {
    MAPS.with(|slot| *slot.borrow_mut() = None);
}

/// 重写单个 class 文件, flags 见 FLAG_*, 返回结果长度; 失败返回 -1
#[no_mangle]
pub extern "C" fn remap_class(ptr: *const u8, len: usize, flags: u32) -> i32 {
    unsafe { crate::classrewrite::set_inherit_methods(flags & crate::classrewrite::FLAG_INHERIT_METHODS != 0) };
    let data = unsafe { slice(ptr, len) };
    let result = MAPS.with(|slot| {
        let maps = slot.borrow();
        match maps.as_ref() {
            Some(m) => classrewrite::remap_class(m, data, flags),
            None => Err("映射表未载入".to_string()),
        }
    });
    finish(result)
}

pub fn remap_class_bytes(maps: &classrewrite::Maps, data: &[u8], flags: u32) -> Result<Vec<u8>, String> {
    classrewrite::remap_class(maps, data, flags)
}

static mut TRACE_ON: bool = false;
static mut TRACE_BUF: Vec<u8> = Vec::new();

pub fn trace_on() -> bool {
    unsafe { TRACE_ON }
}

pub fn trace_push(line: &str) {
    unsafe {
        TRACE_BUF.extend_from_slice(line.as_bytes());
        TRACE_BUF.push(b'\n');
    }
}

#[no_mangle]
pub extern "C" fn trace_begin() {
    unsafe {
        TRACE_ON = true;
        TRACE_BUF.clear();
    }
}

#[no_mangle]
pub extern "C" fn trace_ptr() -> *const u8 {
    unsafe {
        if TRACE_BUF.is_empty() {
            return core::ptr::null();
        }
        TRACE_BUF.as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn trace_len() -> usize {
    unsafe { TRACE_BUF.len() }
}
