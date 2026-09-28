public class EarlyReturnGuard {

    public int grade(int score) {
        if (score < 0) {
            return -1;
        }
        if (score > 100) {
            return -1;
        }
        return score;
    }
}
