public class SwitchColon {

    public int colon(int code) {
        int size = 0;
        switch (code) {
            case 1:
                size = 10;
                break;
            case 2:
                size = 20;
                break;
            default:
                size = 99;
                break;
        }
        return size;
    }
}
