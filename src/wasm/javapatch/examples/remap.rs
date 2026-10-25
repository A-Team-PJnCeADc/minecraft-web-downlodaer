// 原生复现: 读取映射表与单个 class 文件, 输出重写结果或 panic 位置
// 用法: cargo run --release --example remap -- maps.bin class.file out.class
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let maps_blob = std::fs::read(&args[1]).expect("读取映射表");
    let class = std::fs::read(&args[2]).expect("读取 class");
    let flags: u32 = args.get(4).and_then(|f| f.parse().ok()).unwrap_or(0);
    let maps = javapatch::classrewrite::Maps::parse(&maps_blob).expect("解析映射表");
    match javapatch::remap_class_bytes(&maps, &class, flags) {
        Ok(bytes) => {
            if args.len() > 3 {
                let mut f = std::fs::File::create(&args[3]).unwrap();
                f.write_all(&bytes).unwrap();
            }
            println!("输出 {} 字节", bytes.len());
        }
        Err(e) => println!("失败: {e}"),
    }
}
