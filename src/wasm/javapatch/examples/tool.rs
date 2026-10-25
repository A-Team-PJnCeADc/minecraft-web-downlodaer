// 本地校验用小工具(不参与 wasm 构建):
//   cargo run --release --example tool -- lzma <输入> <输出>
//   cargo run --release --example tool -- gdiff <源> <补丁> <输出>
//   cargo run --release --example tool -- adler <文件>

use std::env;
use std::fs;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: tool <lzma|gdiff|adler> ...");
        std::process::exit(2);
    }
    let result = match args[1].as_str() {
        "lzma" => {
            let input = fs::read(&args[2]).expect("读取输入失败");
            javapatch::lzma_decode_bytes(&input)
        }
        "gdiff" => {
            let base = fs::read(&args[2]).expect("读取源文件失败");
            let delta = fs::read(&args[3]).expect("读取补丁失败");
            javapatch::gdiff_apply_bytes(&base, &delta)
        }
        "adler" => {
            let data = fs::read(&args[2]).expect("读取文件失败");
            println!("{:08x}", javapatch::adler32_bytes(&data));
            return;
        }
        other => {
            eprintln!("未知模式: {other}");
            std::process::exit(2);
        }
    };
    match result {
        Ok(bytes) => {
            println!("输出 {} 字节", bytes.len());
            if let Some(out) = args.get(4).or_else(|| args.get(3)) {
                fs::write(out, &bytes).expect("写出失败");
            }
        }
        Err(err) => {
            eprintln!("失败: {err}");
            std::process::exit(1);
        }
    }
}
