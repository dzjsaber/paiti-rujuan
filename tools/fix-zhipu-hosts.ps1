# 临时修复：本网络对 open.bigmodel.cn 的 DNS 解析被干扰（查询超时丢包）。
# 通过 hosts 写入已验证可达的 IP（curl 实测 HTTP 401 = 连通）。
# 失效时删除 hosts 中 "open.bigmodel.cn" 一行即可。
# 用法：以管理员身份运行本脚本。

$hostsPath = 'C:\Windows\System32\drivers\etc\hosts'
$content = Get-Content -LiteralPath $hostsPath -Raw
if ($content -match 'open\.bigmodel\.cn') {
    Write-Host 'hosts 已包含 open.bigmodel.cn，无需修改。'
} else {
    $addition = "# zhipu api temp fix (2026-10-15, DNS 干扰绕过)`r`n8.133.182.104 open.bigmodel.cn`r`n"
    Add-Content -LiteralPath $hostsPath -Value $addition
    Write-Host '已写入 hosts。'
}
Start-Sleep -Seconds 1
Write-Host '当前解析结果：'
Resolve-DnsName open.bigmodel.cn -Type A -ErrorAction SilentlyContinue | Select-Object Name, IPAddress | Format-Table -AutoSize
Write-Host '按回车键关闭…'
Read-Host
