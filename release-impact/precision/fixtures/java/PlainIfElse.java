public class PlainIfElse {

    public int plain(int score) {
        int bonus = 0;
        if (score > 50) {
            bonus = 1;
        } else {
            bonus = -1;
        }
        return bonus;
    }
}
