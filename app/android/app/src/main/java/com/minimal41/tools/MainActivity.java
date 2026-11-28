package com.minimal41.tools;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** ウィジェットや通知から開いたとき、最初に出すページ（"music"） */
    static final String EXTRA_OPEN = "com.minimal41.tools.OPEN";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // アプリ独自のプラグイン（音楽の一覧・再生）
        registerPlugin(MusicLibraryPlugin.class);
        registerPlugin(MusicPlayerPlugin.class);
        registerPlugin(AppUpdatePlugin.class); // ページの自動更新
        super.onCreate(savedInstanceState);
        openFromIntent(getIntent());

        // 戻るボタン：ページの履歴があれば戻る。なければアプリを閉じずに裏へ回す（音楽はそのまま流れる）
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openFromIntent(intent);
    }

    /** ウィジェット・通知から開いたときは Music のページを出す（すでに開いていればそのまま） */
    private void openFromIntent(Intent intent) {
        if (intent == null || !"music".equals(intent.getStringExtra(EXTRA_OPEN)) || getBridge() == null) return;
        intent.removeExtra(EXTRA_OPEN);
        WebView webView = getBridge().getWebView();
        webView.post(() -> {
            String url = webView.getUrl();
            if (url != null && url.contains("/music/")) return;
            webView.loadUrl(getBridge().getLocalUrl() + "/music/index.html");
        });
    }
}
