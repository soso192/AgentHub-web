// 构建脚本：把「这次构建的时刻」注入成编译期常量，供 /api/version 显示与排错用。
//
// 为什么不读 exe 的文件 mtime：mtime 会在拷贝/解压过程中变（分发到各台机器时），
// 而这里注入的是**编译那一刻**，是这份二进制真正的"出生时间"。
//
// 没写 rerun-if-* 指令时，cargo 只在包内文件有变化时才重跑本脚本 —— 正合适：
// 源码没变就不会重新构建，时间戳自然等于"这次构建的时刻"。
fn main() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=CCWEB_BUILD_UNIX={now}");
}
