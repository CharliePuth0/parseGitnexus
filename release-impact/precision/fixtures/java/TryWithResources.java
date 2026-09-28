import java.io.Closeable;

public class TryWithResources {

    public int twr(Closeable res, int need) throws Exception {
        int got = 0;
        try (Closeable c = res) {
            if (need > 0) {
                got = need;
            } else {
                got = -1;
            }
        }
        return got;
    }
}
