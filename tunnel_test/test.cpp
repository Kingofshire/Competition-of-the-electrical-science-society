#include "iostream"
using namespace std;

int main(){
    int n;
    std::cin >> n;
    for(int i = n-1; i >= 1; i--){
        n *= i;
    }
    std::cout << n;
}