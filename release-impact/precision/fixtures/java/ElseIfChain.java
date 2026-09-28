public class ElseIfChain {

    public String band(int score) {
        String band = "F";
        if (score >= 90) {
            band = "A";
        } else if (score >= 80) {
            band = "B";
        } else {
            band = "C";
        }
        return band;
    }
}
