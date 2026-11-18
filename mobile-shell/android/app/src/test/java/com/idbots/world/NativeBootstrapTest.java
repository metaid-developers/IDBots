package com.idbots.world;

import static org.junit.Assert.assertEquals;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class NativeBootstrapTest {
    @Test
    public void readsLargeUtf8StreamWithoutApi33ReadAllBytes() throws Exception {
        StringBuilder expected = new StringBuilder("const origin=__IDBOTS_REMOTE_ORIGIN_JSON__;//");
        for (int i = 0; i < 6000; i++) {
            expected.append('a');
        }
        expected.append("中文🚀");
        ByteArrayInputStream input = new ByteArrayInputStream(expected.toString().getBytes(StandardCharsets.UTF_8));
        assertEquals(expected.toString(), NativeBootstrap.readUtf8(input));
    }
}
