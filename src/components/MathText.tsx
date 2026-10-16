/**
 * 含公式文本的渲染：检测 $...$（行内）与 $$...$$（独立行）。
 * 无公式 → 普通 Text（保持原样式）；有公式 → WebView + KaTeX（auto-render）渲染。
 * shortcut: KaTeX 走 CDN（jsdelivr），离线或 CDN 不可达时显示公式源码；需要离线可改为内嵌资源。
 * shortcut: 只识别 $ 定界符；模型输出裸 LaTeX（无定界符）时不渲染（显示原文，不影响使用）。
 */
import { useState } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { WebView } from 'react-native-webview';

const HAS_MATH = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface MathTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
}

export function MathText({ text, style }: MathTextProps) {
  const [height, setHeight] = useState(44);
  if (!HAS_MATH.test(text)) {
    return <Text style={style}>{text}</Text>;
  }
  const flat = StyleSheet.flatten(style) ?? {};
  const fontSize = typeof flat.fontSize === 'number' ? flat.fontSize : 15;
  const color = typeof flat.color === 'string' ? flat.color : '#333';
  const lineHeight = typeof flat.lineHeight === 'number' ? flat.lineHeight : Math.round(fontSize * 1.5);
  const html = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
  onload="try{renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false});}catch(e){}
  window.ReactNativeWebView.postMessage(String(document.body.scrollHeight));"></script>
<style>body{margin:0;padding:0;font-size:${fontSize}px;line-height:${lineHeight}px;color:${color};
font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;word-break:break-word;}</style>
</head><body>${escapeHtml(text).replace(/\n/g, '<br/>')}</body></html>`;
  return (
    <WebView
      source={{ html }}
      style={{ height, backgroundColor: 'transparent' }}
      scrollEnabled={false}
      originWhitelist={['*']}
      javaScriptEnabled
      onMessage={(e) => {
        const n = Number(e.nativeEvent.data);
        if (Number.isFinite(n) && n > 20 && Math.abs(n + 4 - height) > 2) setHeight(n + 4);
      }}
    />
  );
}
