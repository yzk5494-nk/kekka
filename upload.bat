@echo off
echo VPSにファイルをアップロード中...
scp "C:\Users\23-8\Desktop\結果アプリ\article-generator.html" root@160.251.181.59:/root/結果アプリ/
scp "C:\Users\23-8\Desktop\結果アプリ\wp-poster.js" root@160.251.181.59:/root/結果アプリ/
echo.
echo アップロード完了！
pause
