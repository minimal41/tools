package com.minimal41.tools;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // アプリ独自のプラグイン（音楽の一覧・再生）
        registerPlugin(MusicLibraryPlugin.class);
        registerPlugin(MusicPlayerPlugin.class);
        registerPlugin(AppUpdatePlugin.class); // ページの自動更新
        super.onCreate(savedInstanceState);

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
}
