public class TryCatchFinally {

    public int guards(String text) {
        int len = 0;
        try {
            if (text == null) {
                throw new IllegalArgumentException("need text");
            }
            len = text.length();
        } catch (IllegalArgumentException e) {
            if (e == null) {
                return -2;
            }
            len = -1;
        } finally {
            len = len + 1;
        }
        return len;
    }
}
