package com.notestudio.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 本地插件必须在 super.onCreate（内部 this.load() 创建 bridge）之前注册，
        // 否则 bridge 建好后插件不在表里，JS 侧 registerPlugin('SaveToDownloads') 会找不到。
        registerPlugin(SaveToDownloadsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
