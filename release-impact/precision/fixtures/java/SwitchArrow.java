public class SwitchArrow {

    public int arrow(int code) {
        int size = 0;
        switch (code) {
            case 1 -> size = 10;
            case 2 -> size = 20;
            default -> size = 99;
        }
        return size;
    }
}
