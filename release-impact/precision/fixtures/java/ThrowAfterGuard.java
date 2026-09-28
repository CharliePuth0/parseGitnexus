public class ThrowAfterGuard {

    public int guarded(int mode) {
        int state = 0;
        if (mode < 0) {
            throw new IllegalStateException("bad mode");
        }
        if (mode == 0) {
            state = 1;
        }
        return state;
    }
}
