package com.youcoded.app.runtime

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pins which links open inside YouCoded's own window (so the app can come back) and which go to the plain browser.
 *  WHY (Destin, final review Q-12): every sign-in must return to the app, so each sign-in page has to be on this list. */
class SignInReturnTest {
    @Test fun `claude and chatgpt sign-in pages stay in the app`() {
        assertTrue(SignInReturn.isSignInLink("https://claude.ai/oauth/authorize?code=true&client_id=x"))
        assertTrue(SignInReturn.isSignInLink("https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455"))
    }

    @Test fun `the youcoded account sign-in stays in the app`() =
        assertTrue(SignInReturn.isSignInLink("https://api.youcoded.ai/auth/github/start-redirect?user_code=ABCD-1234"))

    @Test fun `openrouter and the github code page stay in the app`() {
        assertTrue(SignInReturn.isSignInLink("https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A5000%2Fx"))
        assertTrue(SignInReturn.isSignInLink("https://github.com/login/device"))
    }

    @Test fun `ordinary links still go to the browser`() {
        assertFalse(SignInReturn.isSignInLink("https://github.com/itsdestin/youcoded"))
        assertFalse(SignInReturn.isSignInLink("https://claude.ai/"))
        assertFalse(SignInReturn.isSignInLink("https://api.youcoded.ai/skills"))
        assertFalse(SignInReturn.isSignInLink("https://evil.example/auth/?x=claude.ai"))
        assertFalse(SignInReturn.isSignInLink("not a link"))
    }
}
